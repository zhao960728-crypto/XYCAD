"""Read explicitly selected saved solids from a modern SLDPRT offline."""

import json
import math
import re
import struct
import sys
import zlib
from pathlib import Path
import xml.etree.ElementTree as ET

sys.path.insert(0, str(Path(__file__).resolve().parent))
from sldprt_configurations import read_configurations
from sldprt_curves import precise_mapper


MAX_BYTES = 64 * 1024 * 1024
RECORD = bytes.fromhex("140006000800")
TRANSMIT = bytes.fromhex("231dd571da8148a2a85898b21b89ef99")
CONFIG = re.compile(rb"Contents/Config-(\d+)-Partition")
CACHE = re.compile(rb"Contents/Config-(\d+)-LWDATA")


def inflate(payload, size, wbits):
    if not 0 < size <= MAX_BYTES:
        raise ValueError("invalid declared size")
    decoder = zlib.decompressobj(wbits)
    plain = decoder.decompress(payload, size + 1)
    if len(plain) != size or not decoder.eof or decoder.unused_data or decoder.unconsumed_tail:
        raise ValueError("invalid compressed record")
    return plain


def read_streams(raw):
    if raw[4:8] != bytes.fromhex("00000004") or RECORD not in raw[:512]:
        raise ValueError("unsupported container")
    streams, versions = {}, set()
    expanded = 0
    verified_end = 0
    for match in re.finditer(re.escape(RECORD), raw):
        offset = match.start()
        if offset < verified_end:
            continue
        if offset + 26 > len(raw):
            break
        crc, size, plain_size, name_size = struct.unpack_from("<4I", raw, offset + 10)
        if not 1 <= name_size <= 128:
            continue
        start = offset + 26 + name_size
        name = bytes((b >> 4) | ((b & 15) << 4) for b in raw[offset + 26:start])
        version = re.fullmatch(rb"_MO_VERSION_(\d+)/[A-Za-z]+", name)
        if version:
            versions.add(int(version[1]))
        selected = CONFIG.fullmatch(name) or CACHE.fullmatch(name) or name in (
            b"Contents/CMgrHdr2", b"docProps/ISolidWorksInformation.xml")
        if not selected or not size or start + size > len(raw):
            continue
        try:
            plain = inflate(raw[start:start + size], plain_size, -15)
        except zlib.error:
            # The directory at the end may repeat a record name without a payload.
            continue
        if zlib.crc32(plain) != crc:
            raise ValueError("corrupt configuration record")
        expanded += len(plain)
        if expanded > 128 * 1024 * 1024:
            raise ValueError("configuration streams exceed byte budget")
        key = name.decode("ascii")
        if key in streams and streams[key] != plain:
            raise ValueError("conflicting configuration stream")
        streams[key] = plain
        verified_end = start + size
    if len(versions) != 1 or "Contents/CMgrHdr2" not in streams:
        raise ValueError("missing or ambiguous configuration registry")
    return streams, versions.pop()


def configuration_list(streams, version):
    configurations = read_configurations(streams["Contents/CMgrHdr2"], version)
    for row in configurations:
        row["savedGeometry"] = "Contents/Config-" + row["id"] + "-Partition" in streams
    marked = [row["id"] for row in configurations if row["state"] == 1]
    active = marked[0] if len(marked) == 1 and all(row["state"] in (0, 1) for row in configurations) else None
    xml = streams.get("docProps/ISolidWorksInformation.xml")
    if xml:
        if b"<!DOCTYPE" in xml.upper() or b"<!ENTITY" in xml.upper() or len(xml) > 4 * 1024 * 1024:
            raise ValueError("unsupported configuration metadata XML")
        names = {next(iter(prop)).text for prop in ET.fromstring(xml).iter()
                 if prop.attrib.get("name") == "SW-Configuration Name" and len(prop)}
        if active is None and len(names) == 1:
            active = next((row["id"] for row in configurations if row["name"] in names), None)
    return configurations, active


def select_partition(raw, requested=None):
    streams, version = read_streams(raw)
    configurations, active = configuration_list(streams, version)
    selected = requested if requested is not None else active or configurations[0]["id"]
    if not any(row["id"] == selected for row in configurations):
        raise ValueError("unknown configuration")
    key = "Contents/Config-" + selected + "-Partition"
    if key not in streams:
        raise ValueError("missing saved configuration partition")
    return streams[key]


def read_partition(raw):
    return select_partition(raw)


def saved_bounds(streams, selected):
    data = streams.get("Contents/Config-" + selected + "-LWDATA")
    if data is None:
        return None
    if len(data) < 76:
        raise ValueError("truncated configuration bounds")
    center_x, center_y, center_z, *values = struct.unpack_from("<9d", data, 4)
    upper, lower = values[:3], values[3:]
    if (not all(math.isfinite(value) and abs(value) < 1e10 for value in [center_x, center_y, center_z, *values]) or
            any(low > high for low, high in zip(lower, upper))):
        raise ValueError("invalid configuration bounds")
    return [value * 1000 for value in [*lower, *upper]]


def read_transmit(partition):
    offset = 0
    model = None
    while offset < len(partition):
        if offset + 28 > len(partition) or partition[offset + 4:offset + 20] != TRANSMIT:
            raise ValueError("invalid transmit record")
        end = offset + 4 + struct.unpack_from("<I", partition, offset)[0]
        cursor = offset + 20
        if end > len(partition) or cursor + 8 > end:
            raise ValueError("invalid transmit range")
        transmit = bytearray()
        while cursor + 8 <= end:
            plain_size, size = struct.unpack_from("<II", partition, cursor)
            cursor += 8
            if not plain_size and not size and cursor == end:
                break
            if not size or cursor + size > end or len(transmit) + plain_size > MAX_BYTES:
                raise ValueError("invalid transmit chunk")
            transmit.extend(inflate(partition[cursor:cursor + size], plain_size, 15))
            cursor += size
        if cursor != end:
            raise ValueError("invalid transmit boundary")
        header = transmit[:80]
        if header.startswith(b"PS") and b"(partition)" in header and model is None:
            model = bytes(transmit)
        elif not header.startswith(b"PS") or b"(deltas)" not in header:
            raise ValueError("unsupported or ambiguous transmit")
        offset = end
    if model is None:
        raise ValueError("missing saved partition")
    return model


def identity_transforms(model):
    valid = set()
    for node in model.nodes.values():
        if node.type != 100:
            continue
        fields = node.f
        rotation = fields.get("rotation_matrix")
        translation = fields.get("translation_vector")
        if (not isinstance(rotation, (list, tuple)) or len(rotation) != 9 or
                not isinstance(translation, (list, tuple)) or len(translation) != 3 or
                not all(math.isfinite(value) for value in [*rotation, *translation]) or
                any(abs(value - (1 if index % 4 == 0 else 0)) > 1e-12 for index, value in enumerate(rotation)) or
                any(abs(value) > 1e-12 for value in translation) or fields.get("scale") != 1 or fields.get("flag") != 0):
            return False
        valid.add(node.index)
    return all(not node.f.get("transform") or node.f["transform"] in valid for node in model.nodes.values())


def legacy_thumbnail(raw, target):
    if not raw.startswith(bytes.fromhex('d0cf11e0a1b11ae1')):
        return
    from sldprt2step_lib.container.ole_cfb import OleContainerParser
    parser = OleContainerParser(raw)
    images = []
    for entry in parser.entries:
        if entry.type != 2 or entry.name not in ('PreviewPNG', 'Preview') or not 0 < entry.size <= 8 * 1024 * 1024:
            continue
        stream = parser.extract_stream(entry.name)
        if not stream:
            continue
        data = stream.data
        if data.startswith(bytes.fromhex('89504e470d0a1a0a')) or data[:4] == b'\x28\x00\x00\x00':
            images.append(data)
    if len(images) == 1:
        Path(str(target) + '.thumbnail').write_bytes(images[0])


def main():
    parser, source, target = sys.argv[1:4]
    requested = sys.argv[4] if len(sys.argv) > 4 and sys.argv[4] else None
    preview = len(sys.argv) > 5 and sys.argv[5] == 'preview'
    sys.path.insert(0, parser)
    try:
        from sldprt2step_lib.step.convert import _bodies_of
        from sldprt2step_lib.step import mapper
        from sldprt2step_lib.xt import geom
        from sldprt2step_lib.xt.reader import read_xt
    except ImportError:
        return 3
    metadata = {}
    try:
        with Path(source).open("rb") as file:
            raw = file.read(MAX_BYTES + 1)
        if len(raw) > MAX_BYTES:
            raise ValueError("source exceeds byte budget")
        streams, version = read_streams(raw)
        configurations, active = configuration_list(streams, version)
        selected = requested if requested is not None else active or configurations[0]["id"]
        metadata = dict(configurations=configurations, selectedConfiguration=selected)
        if not any(row["id"] == selected for row in configurations):
            raise ValueError("unknown configuration")
        bounds = saved_bounds(streams, selected)
        if bounds is not None:
            metadata["savedBounds"] = bounds
        partition = streams.get("Contents/Config-" + selected + "-Partition")
        if partition is None:
            raise ValueError("missing saved configuration partition")
        model = read_xt(read_transmit(partition))
        bodies = _bodies_of(model)
        if not bodies:
            raise ValueError("empty saved partition")
        if (len(bodies) > 256 or any(body.f.get("body_type") != 1 for body in bodies) or model.trailing_bytes or
                not identity_transforms(model)):
            raise ValueError("unsupported saved solid")
        warnings = []
        original = mapper.XtStepMapper
        # Each request runs in its own Python process. Restore the configured mapper after use.
        mapper.XtStepMapper = precise_mapper(original, geom, mapper.fmt, preview)
        try:
            step, solids, faces = mapper.write_step(
                [(model, body, "Body " + str(index + 1)) for index, body in enumerate(bodies)], "SLDPRT.step", warnings)
        finally:
            mapper.XtStepMapper = original
        if solids != len(bodies) or not faces or warnings and not preview or len(step) > MAX_BYTES:
            raise ValueError("incomplete or oversized STEP result")
        Path(target).write_bytes(step.encode("ascii"))
        metadata["solidCount"] = solids
        if warnings:
            metadata.update(previewOnly=True, approximationWarnings=warnings[:32])
        print(json.dumps(metadata, ensure_ascii=True))
    except Exception as error:
        try:
            legacy_thumbnail(raw, target)
        except Exception:
            pass
        metadata["reason"] = str(error)[:300]
        print(json.dumps(metadata, ensure_ascii=True))
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
