"""Supply cylinder parameter curves for analytic ellipse edges in saved solids."""

import math
import re


def precise_mapper(base, geometry, number):
    class Mapper(base):
        def __init__(self, *args):
            super().__init__(*args)
            self._vertex_pos = {}
            self.edge_surfaces = {}
            self.parameter_points = 0
            for face in self.xt.nodes.values():
                if face.name != "FACE":
                    continue
                surface = self.deref(face, "surface")
                for loop in self.chain(self.deref(face, "loop"), "next"):
                    for fin in self.fin_ring(loop):
                        edge = self.deref(fin, "edge")
                        if edge and surface:
                            self.edge_surfaces.setdefault(edge.index, {})[surface.index] = surface

        def warn(self, key, text):
            # The upload contract accepts complete conversions without approximation warnings.
            raise ValueError("unsupported saved geometry: " + key)

        def cylinder_pcurve(self, curve, surface):
            if surface.type != 51:
                return None
            info = self.surface(surface)
            cylinder = info.ev
            fields = curve.f
            x = geometry.unit(fields["x_axis"])
            y = geometry.cross(geometry.unit(fields["normal"]), x)
            center = fields["centre"]
            major, minor = fields["major_radius"], fields["minor_radius"]
            # Cubic Hermite error for the axial sine/cosine is bounded by A*h^4/384.
            amplitude_mm = 1000 * (abs(geometry.dot(x, cylinder.a) * major) +
                                   abs(geometry.dot(y, cylinder.a) * minor))
            steps = max(32, math.ceil(2 * math.pi * (amplitude_mm / (384 * 1e-8)) ** 0.25))
            if steps > 2048:
                raise ValueError("ellipse parameter curve exceeds precision budget")
            positions, derivatives = [], []
            previous = None
            interval = 2 * math.pi / steps
            for index in range(steps + 1):
                angle = index * interval
                point = geometry.add(center, geometry.add(geometry.mul(x, major * math.cos(angle)),
                                                           geometry.mul(y, minor * math.sin(angle))))
                tangent = geometry.add(geometry.mul(x, -major * math.sin(angle)),
                                       geometry.mul(y, minor * math.cos(angle)))
                u, v = cylinder.project(point)
                if previous is not None:
                    u += 2 * math.pi * round((previous - u) / (2 * math.pi))
                previous = u
                radial = geometry.sub(geometry.sub(point, cylinder.p), geometry.mul(cylinder.a, v))
                if abs(geometry.norm(radial) - cylinder.r) > max(1e-12, cylinder.r * 1e-10):
                    return None
                du = (geometry.dot(radial, cylinder.x) * geometry.dot(tangent, cylinder.y) -
                      geometry.dot(radial, cylinder.y) * geometry.dot(tangent, cylinder.x)) / cylinder.r ** 2
                if abs(abs(du) - 1) > 1e-8:
                    return None
                positions.append((u, v * 1000))
                derivatives.append((du, geometry.dot(tangent, cylinder.a) * 1000))
            controls = [positions[0]]
            for index in range(steps):
                a, b = positions[index:index + 2]
                da, db = derivatives[index:index + 2]
                controls.extend([(a[0] + interval * da[0] / 3, a[1] + interval * da[1] / 3),
                                 (b[0] - interval * db[0] / 3, b[1] - interval * db[1] / 3), b])
            self.parameter_points += len(controls)
            if self.parameter_points > 100_000:
                raise ValueError("parameter curves exceed output budget")
            points = [self.w.add("CARTESIAN_POINT('',(%s,%s))" % (number(u), number(v))) for u, v in controls]
            knots = [number(index * interval) for index in range(steps + 1)]
            mult = [4] + [3] * (steps - 1) + [4]
            spline = self.w.add(
                "B_SPLINE_CURVE_WITH_KNOTS('',3,(%s),.UNSPECIFIED.,.F.,.F.,(%s),(%s),.UNSPECIFIED.)" %
                (",".join("#%d" % point for point in points), ",".join(map(str, mult)), ",".join(knots)))
            context = self.w.add("(GEOMETRIC_REPRESENTATION_CONTEXT(2)PARAMETRIC_REPRESENTATION_CONTEXT()"
                                 "REPRESENTATION_CONTEXT('',''))")
            representation = self.w.add("DEFINITIONAL_REPRESENTATION('',(#%d),#%d)" % (spline, context))
            return self.w.add("PCURVE('',#%d,#%d)" % (info.step_id, representation))

        def edge_curve(self, edge, bbox):
            exists = edge.index in self._edge
            result = super().edge_curve(edge, bbox)
            curve = self.deref(edge, "curve")
            if exists or not curve or curve.type != 32:
                return result
            surfaces = self.edge_surfaces.get(edge.index, {}).values()
            if not surfaces or any(surface.type != 51 for surface in surfaces):
                return result
            associated = [self.cylinder_pcurve(curve, surface) for surface in surfaces]
            if associated and all(associated):
                edge_id = result[0]
                line = self.w.lines[edge_id - 1]
                match = re.fullmatch(r"#\d+=EDGE_CURVE\('',#\d+,#\d+,#(\d+),\.[TF]\.\);", line)
                if not match:
                    raise ValueError("unsupported STEP edge serialization")
                surface_curve = self.w.add("SURFACE_CURVE('',#%s,(%s),.CURVE_3D.)" %
                                           (match[1], ",".join("#%d" % curve_id for curve_id in associated)))
                self.w.lines[edge_id - 1] = line.replace(",#" + match[1] + ",", ",#" + str(surface_curve) + ",")
            return result
    return Mapper
