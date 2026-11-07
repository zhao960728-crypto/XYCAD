import importlib.util
import struct
import sys
import unittest
import zlib
from pathlib import Path
from types import SimpleNamespace

script = Path(__file__).resolve().parents[1] / "scripts" / "sldprt-offline.py"
spec = importlib.util.spec_from_file_location("offline_part", script)
reader = importlib.util.module_from_spec(spec)
spec.loader.exec_module(reader)


def text(value):
    return b"\xff\xfe\xff" + bytes([len(value)]) + value.encode("utf-16-le")


def class_tag(name):
    encoded = name.encode("ascii")
    return b"\xff\xff\x01\x00" + struct.pack("<H", len(encoded)) + encoded


def configuration(slot, name, active=False, first=False):
    return ((class_tag("dmConfigHeader_c") if first else b"\x03\x80") +
            struct.pack("<I", int(active)) + text(name) + struct.pack("<II", slot, 0) +
            text(name) + struct.pack("<II", 0xffffffff, 0) + text("") + text("") + b"\0" * 16)


def record(name, payload):
    compressor = zlib.compressobj(wbits=-15)
    data = compressor.compress(payload) + compressor.flush()
    encoded = bytes((b >> 4) | ((b & 15) << 4) for b in name.encode("ascii"))
    return reader.RECORD + b"\0" * 4 + struct.pack("<4I", zlib.crc32(payload), len(data), len(payload), len(encoded)) + encoded + data


class Configurations(unittest.TestCase):
    def source(self):
        registry = class_tag("dmConfigMgrHeader_c") + struct.pack("<H", 2)
        # Configuration IDs and registry order differ. A third on-disk partition is deleted.
        registry += configuration(3, "Flat", first=True)
        registry += configuration(0, "Folded", active=True)
        metadata = b'<Properties><property name="SW-Configuration Name"><value>Flat</value></property></Properties>'
        return (b"SWX!\0\0\0\x04" + record("_MO_VERSION_18000/History", b"version") +
                record("Contents/CMgrHdr2", registry) +
                record("Contents/Config-0-Partition", b"folded solid") +
                record("Contents/Config-3-Partition", b"flat solid") +
                record("Contents/Config-99-Partition", b"deleted solid") +
                record("docProps/ISolidWorksInformation.xml", metadata))

    def test_slots_are_bound_to_the_registry_and_active_flag(self):
        source = self.source()
        streams, version = reader.read_streams(source)
        configurations, active = reader.configuration_list(streams, version)
        self.assertEqual([row["id"] for row in configurations], ["3", "0"])
        self.assertEqual(active, "0")
        self.assertEqual(reader.read_partition(source), b"folded solid")
        self.assertEqual(reader.select_partition(source, "3"), b"flat solid")
        with self.assertRaises(ValueError):
            reader.select_partition(source, "99")

    def test_incomplete_registry_is_rejected(self):
        with self.assertRaises(ValueError):
            reader.read_configurations(class_tag("dmConfigMgrHeader_c") + b"\x01\x00", 18000)

    def test_saved_ranges_are_selected_per_configuration(self):
        streams = {"Contents/Config-3-LWDATA": b'\0'*4 + struct.pack('<9d', 0,0,0, .1,.2,.3, -.1,-.2,-.3)}
        self.assertEqual(reader.saved_bounds(streams, '3'), [-100,-200,-300,100,200,300])
        self.assertIsNone(reader.saved_bounds(streams, '0'))
        streams["Contents/Config-3-LWDATA"] = b'\0'
        with self.assertRaises(ValueError): reader.saved_bounds(streams, '3')

    def test_identity_transforms_accept_tuple_vectors_and_reject_scale(self):
        transform = SimpleNamespace(type=100, index=3, f=dict(rotation_matrix=[1,0,0,0,1,0,0,0,1],
            translation_vector=(0,0,0), scale=1, flag=0))
        world = SimpleNamespace(type=0, index=1, f=dict(transform=3))
        model = SimpleNamespace(nodes={1:world,3:transform})
        self.assertTrue(reader.identity_transforms(model))
        transform.f["scale"] = 2
        self.assertFalse(reader.identity_transforms(model))
        transform.f["scale"] = 1
        world.f["transform"] = 9
        self.assertFalse(reader.identity_transforms(model))


if __name__ == "__main__":
    unittest.main()
