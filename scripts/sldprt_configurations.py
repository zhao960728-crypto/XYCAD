"""Read the modern container's configuration registry and its explicit slot IDs."""

class Cursor:
    def __init__(self, data):
        self.data = data
        self.offset = 0

    def take(self, size):
        end = self.offset + size
        if end > len(self.data):
            raise ValueError("truncated configuration registry")
        result = self.data[self.offset:end]
        self.offset = end
        return result

    def integer(self, width=4):
        return int.from_bytes(self.take(width), "little")

    def text(self):
        size = self.integer(1)
        unicode = size == 255
        if unicode:
            if self.take(2) != b"\xfe\xff":
                raise ValueError("unsupported configuration name encoding")
            size = self.integer(1)
        if size == 255:
            size = self.integer(2)
            if size == 65535:
                size = self.integer()
        if size > 1024:
            raise ValueError("configuration name exceeds budget")
        return self.take(size * (2 if unicode else 1)).decode("utf-16-le" if unicode else "ascii")

    def class_tag(self, expected, reference=None):
        tag = self.integer(2)
        if reference is not None and tag == reference:
            return
        if tag != 65535:
            raise ValueError("unsupported configuration object reference")
        if self.integer(2) != 1:
            raise ValueError("unsupported configuration object schema")
        size = self.integer(2)
        if size > 64 or self.take(size).decode("ascii") != expected:
            raise ValueError("unsupported configuration object class")


def read_configurations(data, version):
    cursor = Cursor(data)
    cursor.class_tag("dmConfigMgrHeader_c")
    count = cursor.integer(2)
    if count == 65535:
        count = cursor.integer()
    if not 1 <= count <= 256 or not 8000 <= version <= 19000:
        raise ValueError("unsupported configuration registry version or count")
    result = []
    for _ in range(count):
        cursor.class_tag("dmConfigHeader_c", 0x8003)
        state = cursor.integer()
        name, slot = cursor.text(), cursor.integer()
        cursor.integer()
        cursor.text()
        parent = cursor.integer()
        cursor.integer()
        cursor.text()
        cursor.text()
        cursor.integer()
        if version >= 11142:
            cursor.integer()
        if version >= 12155:
            cursor.integer()
        if version >= 12216:
            cursor.integer()
        if not name or slot > 1_000_000 or any(row["id"] == str(slot) or row["name"] == name for row in result):
            raise ValueError("ambiguous configuration registry")
        result.append(dict(id=str(slot), name=name, parent=None if parent == 0xffffffff else str(parent),
                           state=state))
    return result
