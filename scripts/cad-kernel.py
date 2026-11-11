"""Bounded, offline FreeCAD worker. Reads copies; never saves the input file."""
import array
import json
import math
import os
import sys
from pathlib import Path

import FreeCAD as App
import Part

PROGRESS_DIRECTORY = None


def write_json(path, data):
    target = Path(path)
    temporary = target.with_name(target.name + '.' + str(os.getpid()) + '.new')
    temporary.write_text(json.dumps(data, ensure_ascii=True, allow_nan=False), encoding='utf8')
    os.replace(temporary, target)


def progress(directory, stage, completed=0, total=0):
    write_json((PROGRESS_DIRECTORY or directory) / 'kernel-progress.json', dict(stage=stage, completed=completed, total=total))


def bounds(shape):
    b = shape.BoundBox
    return [b.XMin, b.YMin, b.ZMin, b.XMax, b.YMax, b.ZMax]


def parts_of(shape):
    # Neutral STEP data has no SolidWorks feature/configuration history.
    # Keep all placed solids; retain surface-only input as a separate shape.
    parts = shape.Solids
    if parts and sum(len(p.Faces) for p in parts) == len(shape.Faces):
        return parts
    return [shape]


def solid_volume(shape, valid):
    if not valid:
        return None
    solids = shape.Solids
    if not solids or sum(len(solid.Faces) for solid in solids) != len(shape.Faces):
        return None
    volumes = [abs(solid.Volume) for solid in solids]
    return sum(volumes) if all(math.isfinite(value) and value > 0 for value in volumes) else None


def read_step(source):
    if source.stat().st_size > 128 * 1024 * 1024:
        raise ValueError('辅助解析输入超过 128 MiB 容量。')
    shape = Part.read(str(source))
    if shape.isNull() or not shape.Faces:
        raise ValueError('离线 CAD 内核没有读取到曲面几何。')
    if len(shape.Faces) > 100_000:
        raise ValueError('辅助解析曲面数量超过容量。')
    return shape


def volume(request, directory):
    shape = read_step(Path(request['source']))
    write_json(request['output'], dict(volume=solid_volume(shape, shape.isValid())))


def load(request, directory):
    import MeshPart
    source = Path(request['source'])
    progress(directory, 'kernel-read')
    shape = read_step(source)
    valid = shape.isValid()
    shape.exportBrep(str(directory / 'kernel.brep'))
    parts = parts_of(shape)
    if len(parts) > 4096:
        raise ValueError('辅助解析零件数量超过容量。')
    rows = []
    total = 0
    for index, part in enumerate(parts):
        progress(directory, 'kernel-mesh', index, len(parts))
        b = part.BoundBox
        # Display mesh resolution is independent of BREP and exact HLR.
        # Bound the overview work; preserve the original geometry for projection.
        chord = max(0.03, min(0.3, b.DiagonalLength * 0.0003))
        local = part.copy()
        placement = local.Placement
        local.Placement = App.Placement()
        center = local.BoundBox.Center
        mesh = MeshPart.meshFromShape(Shape=local, LinearDeflection=chord, AngularDeflection=0.5, Relative=False)
        vertices, triangles = mesh.Topology
        if not triangles or len(triangles) > 1_000_000 or total + len(triangles) > 5_000_000:
            raise ValueError('辅助解析显示网格超过容量。')
        coordinates = array.array('d')
        for triangle in triangles:
            for vertex in triangle:
                p = vertices[vertex]
                coordinates.extend((round(p.x-center.x, 12), round(p.y-center.y, 12), round(p.z-center.z, 12)))
        if sys.byteorder != 'little':
            coordinates.byteswap()
        filename = 'kernel-' + str(index) + '.raw'
        with (directory / filename).open('wb') as stream:
            coordinates.tofile(stream)
        rows.append(dict(file=filename, count=len(triangles), bounds=bounds(part),
                         valid=part.isValid(), faces=len(part.Faces), chordMm=chord,
                         placement=list(placement.toMatrix().A), center=[center.x, center.y, center.z]))
        total += len(triangles)
    metadata = dict(schema=1, method='local-kernel-brep', kernel='FreeCAD ' + '.'.join(App.Version()[:3]),
                    occ=Part.OCC_VERSION, bounds=bounds(shape), valid=valid, parts=rows,
                    faces=len(shape.Faces), solids=len(shape.Solids), area=shape.Area, volume=shape.Volume,
                    solidVolume=solid_volume(shape, valid))
    write_json(directory / 'kernel.json', metadata)
    progress(directory, 'ready', len(parts), len(parts))


def project(request, directory):
    import TechDraw
    shape = Part.Shape()
    shape.read(str(directory / 'kernel.brep'))
    if request.get('part') is not None:
        parts = parts_of(shape)
        index = request['part']
        if not isinstance(index, int) or not 0 <= index < len(parts):
            raise ValueError('找不到辅助载入的指定实体。')
        shape = parts[index]
    if not shape.isValid():
        raise ValueError('此几何存在拓扑错误，可查看模型，暂不能生成精确三视图。')
    b = shape.BoundBox
    center = [b.Center.x, b.Center.y, b.Center.z]
    chord = max(0.001, min(0.005, b.DiagonalLength * 0.000005))
    entities = []
    points = 0
    for view in request['layout']['views']:
        transform = App.Matrix()
        for row, axis in enumerate(view['frame']):
            for col in range(3):
                setattr(transform, f'A{row+1}{col+1}', view['basis'][row][col] if view.get('basis') else ((1 if axis > 0 else -1) if col == abs(axis)-1 else 0))
            setattr(transform, f'A{row+1}4', -sum(center[i]*view['basis'][row][i] for i in range(3)) if view.get('basis') else -center[abs(axis)-1] * (1 if axis > 0 else -1))
        progress(directory, 'kernel-project', len(entities), 0)
        # These frames are rigid rotations. Transform the topology/placement;
        # reparameterizing every surface can manufacture a zero-width trim at
        # a spherical pole even when the source BREP is valid.
        placed = shape.copy()
        placed.transformShape(transform)
        groups = TechDraw.projectEx(placed, App.Vector(0, 0, 1))
        for hidden, indices in ([(False, [0, 3])] if view.get('basis') else [(False, [0, 3]), (True, [5, 8])]):
            if request.get('seams'):
                indices.append(6 if hidden else 1)
            for index in indices:
                if groups[index].isNull():
                    continue
                for edge in groups[index].Edges:
                    curve = edge.discretize(Deflection=chord)
                    vertices = [[round(p.x + view['shift'][0], 9), round(p.y + view['shift'][1], 9)] for p in curve]
                    closed = len(vertices) > 2 and math.dist(vertices[0], vertices[-1]) < 1e-8
                    if closed:
                        vertices.pop()
                    if len(vertices) < 2:
                        continue
                    points += len(vertices)
                    if points > 1_000_000 or len(entities) > 100_000:
                        raise ValueError('辅助三视图线条超过输出容量。')
                    layer = view['layer'] + ('-HIDDEN' if hidden else '-VISIBLE')
                    if len(vertices) == 2 and not closed:
                        entities.append(dict(type='LINE', layer=layer, a=vertices[0], b=vertices[1]))
                    else:
                        entities.append(dict(type='LWPOLYLINE', layer=layer, vertices=vertices, closed=closed, patternContinuous=True))
    if not entities:
        raise ValueError('辅助三视图没有可显示的边界。')
    write_json(request['output'], dict(entities=entities, chordMm=chord))


if __name__ == '__main__':
    request = json.loads(Path(sys.argv[1]).read_text(encoding='utf8'))
    directory = Path(request['directory'])
    PROGRESS_DIRECTORY = Path(request.get('progressDirectory', directory))
    try:
        {'load': load, 'volume': volume, 'project': project}[request['operation']](request, directory)
    except Exception as error:
        write_json(request['error'], dict(error=str(error)[:500]))
        sys.exit(2)
