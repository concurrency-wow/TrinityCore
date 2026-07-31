#!/usr/bin/env python3
"""Convert a WotLK 3.3.5 creature display ID to a static textured GLB."""

import argparse
import json
import math
import os
import shutil
import struct
import subprocess
import sys
import tempfile
from pathlib import Path, PureWindowsPath

from PIL import Image


class ConversionError(RuntimeError):
    pass


def u16(data, offset):
    return struct.unpack_from("<H", data, offset)[0]


def i16(data, offset):
    return struct.unpack_from("<h", data, offset)[0]


def u32(data, offset):
    return struct.unpack_from("<I", data, offset)[0]


def array(data, offset, item_size, label):
    count, start = struct.unpack_from("<II", data, offset)
    end = start + count * item_size
    if start > len(data) or end > len(data):
        raise ConversionError(f"{label} points outside its file")
    return count, start


def cstring(block, offset):
    if offset >= len(block):
        return ""
    end = block.find(b"\0", offset)
    return block[offset:end if end >= 0 else len(block)].decode("utf-8", "replace")


def read_dbc(path):
    data = Path(path).read_bytes()
    if len(data) < 20 or data[:4] != b"WDBC":
        raise ConversionError(f"{path} is not a WDBC file")
    records, fields, record_size, string_size = struct.unpack_from("<IIII", data, 4)
    records_end = 20 + records * record_size
    if records_end + string_size > len(data):
        raise ConversionError(f"{path} is truncated")
    rows = [data[20 + i * record_size:20 + (i + 1) * record_size] for i in range(records)]
    return fields, rows, data[records_end:records_end + string_size]


def resolve_display(dbc_dir, display_id):
    fields, rows, strings = read_dbc(Path(dbc_dir) / "CreatureDisplayInfo.dbc")
    if fields < 16:
        raise ConversionError("CreatureDisplayInfo.dbc has an unexpected layout")
    display = None
    for row in rows:
        if u32(row, 0) == display_id:
            display = {
                "display_id": display_id,
                "model_id": u32(row, 4),
                "extended_id": u32(row, 12),
                "scale": struct.unpack_from("<f", row, 16)[0],
                "textures": [cstring(strings, u32(row, field * 4)) for field in (6, 7, 8)],
            }
            break
    if not display:
        raise ConversionError(f"display ID {display_id} is absent from CreatureDisplayInfo.dbc")

    fields, rows, strings = read_dbc(Path(dbc_dir) / "CreatureModelData.dbc")
    if fields < 17:
        raise ConversionError("CreatureModelData.dbc has an unexpected layout")
    for row in rows:
        if u32(row, 0) == display["model_id"]:
            model_path = cstring(strings, u32(row, 8)).replace("\\", "/")
            if model_path.lower().endswith(".mdx"):
                model_path = model_path[:-4] + ".m2"
            display["model_path"] = model_path
            display["model_scale"] = struct.unpack_from("<f", row, 16)[0]
            break
    if "model_path" not in display:
        raise ConversionError(f"model ID {display['model_id']} is absent from CreatureModelData.dbc")

    if display["extended_id"]:
        fields, rows, strings = read_dbc(Path(dbc_dir) / "CreatureDisplayInfoExtra.dbc")
        extra = None
        for row in rows:
            if u32(row, 0) == display["extended_id"]:
                values = [u32(row, field * 4) for field in range(fields)]
                extra = {
                    "race": values[1], "sex": values[2], "skin": values[3], "face": values[4],
                    "hair_style": values[5], "hair_color": values[6], "facial_hair": values[7],
                    "items": values[8:19], "bake_name": cstring(strings, values[20]),
                }
                break
        if not extra:
            raise ConversionError(f"CreatureDisplayInfoExtra record {display['extended_id']} was not found")

        extra["hair_texture"] = ""
        fields, rows, strings = read_dbc(Path(dbc_dir) / "CharSections.dbc")
        for row in rows:
            values = [u32(row, field * 4) for field in range(fields)]
            if values[1] == extra["race"] and values[2] == extra["sex"] and values[3] == 3 and values[8] == extra["hair_style"] and values[9] == extra["hair_color"]:
                extra["hair_texture"] = cstring(strings, values[4])
                break

        visible = {0, 401, 501, 702, 1301, 1501}
        _, rows, _ = read_dbc(Path(dbc_dir) / "CharHairGeosets.dbc")
        for row in rows:
            values = [u32(row, field * 4) for field in range(6)]
            if values[1:4] == [extra["race"], extra["sex"], extra["hair_style"]]:
                visible.add(values[4])
                break
        _, rows, _ = read_dbc(Path(dbc_dir) / "CharacterFacialHairStyles.dbc")
        for row in rows:
            values = [u32(row, field * 4) for field in range(8)]
            if values[:3] == [extra["race"], extra["sex"], extra["facial_hair"]]:
                for group, value in zip((1, 3, 2), values[3:6]):
                    visible.add(group * 100 + value + 1)
                break

        item_records = {}
        fields, rows, _ = read_dbc(Path(dbc_dir) / "ItemDisplayInfo.dbc")
        wanted = set(extra["items"])
        for row in rows:
            item_id = u32(row, 0)
            if item_id in wanted:
                item_records[item_id] = [u32(row, field * 4) for field in range(fields)]
        shirt = item_records.get(extra["items"][2])
        boots = item_records.get(extra["items"][6])
        gloves = item_records.get(extra["items"][8])
        chest = item_records.get(extra["items"][3])
        if shirt and shirt[7]: visible.add(800 + shirt[7] + 1)
        if boots and boots[7]: visible.discard(501); visible.add(500 + boots[7] + 1)
        if gloves and gloves[7]: visible.discard(401); visible.add(400 + gloves[7] + 1)
        if chest and len(chest) > 9 and chest[9]: visible.discard(1301); visible.add(1300 + chest[9] + 1)
        extra["visible_geosets"] = sorted(visible)
        extra["attachment_items"] = [item_id for item_id, values in item_records.items() if values[1] or values[2]]
        display["extra"] = extra
    return display


def archive_paths(client, locale):
    data = Path(client) / "Data"
    localized = data / locale
    numbered = sorted(data.glob("patch-?.MPQ"), key=lambda p: p.name.lower(), reverse=True)
    locale_numbered = sorted(localized.glob(f"patch-{locale}-?.MPQ"), key=lambda p: p.name.lower(), reverse=True)
    paths = numbered + locale_numbered + [
        data / "patch.MPQ", localized / f"patch-{locale}.MPQ", data / "expansion.MPQ",
        data / "lichking.MPQ", data / "common.MPQ", data / "common-2.MPQ",
        localized / f"locale-{locale}.MPQ", localized / f"expansion-locale-{locale}.MPQ",
        localized / f"lichking-locale-{locale}.MPQ",
    ]
    return [p for p in paths if p.is_file()]


class Extractor:
    def __init__(self, client, locale, root):
        self.archives = archive_paths(client, locale)
        self.root = Path(root)
        if not self.archives:
            raise ConversionError(f"no MPQ archives found under {client}/Data")

    def extract(self, internal_path, required=True):
        normalized = str(PureWindowsPath(internal_path.replace("/", "\\")))
        relative = Path(*PureWindowsPath(normalized).parts)
        destination = self.root / relative

        def extracted_file():
            if destination.is_file():
                return destination
            wanted = relative.as_posix().lower()
            for candidate in self.root.rglob(relative.name):
                if candidate.is_file() and candidate.relative_to(self.root).as_posix().lower() == wanted:
                    return candidate
            # StormLib writes the archive's canonical casing, including the filename.
            for candidate in self.root.rglob("*"):
                if candidate.is_file() and candidate.relative_to(self.root).as_posix().lower() == wanted:
                    return candidate
            return None

        existing = extracted_file()
        if existing:
            return existing
        destination.parent.mkdir(parents=True, exist_ok=True)
        for archive in self.archives:
            subprocess.run(
                ["smpq", "-q", "-x", str(archive), normalized], cwd=self.root,
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False,
            )
            result = extracted_file()
            if result:
                return result
        if required:
            raise ConversionError(f"asset not found in client MPQs: {normalized}")
        return None


def parse_m2(path):
    data = Path(path).read_bytes()
    if len(data) < 0x130 or data[:4] != b"MD20" or u32(data, 4) != 264:
        raise ConversionError(f"{path} is not a WotLK M2 v264 model")

    vertex_count, vertex_offset = array(data, 0x3C, 48, "M2 vertices")
    positions, normals, uv0 = [], [], []
    for index in range(vertex_count):
        base = vertex_offset + index * 48
        x, y, z = struct.unpack_from("<fff", data, base)
        nx, ny, nz = struct.unpack_from("<fff", data, base + 20)
        u, v = struct.unpack_from("<ff", data, base + 32)
        positions.append((x, -z, y))
        normals.append((nx, -nz, ny))
        uv0.append((u, v))

    texture_count, texture_offset = array(data, 0x50, 16, "M2 textures")
    textures = []
    for index in range(texture_count):
        base = texture_offset + index * 16
        name_length, name_offset = struct.unpack_from("<II", data, base + 8)
        if name_offset + name_length > len(data):
            raise ConversionError("M2 texture filename points outside the file")
        name = data[name_offset:name_offset + name_length].rstrip(b"\0").decode("utf-8", "replace")
        textures.append({"type": u32(data, base), "flags": u32(data, base + 4), "name": name})

    material_count, material_offset = array(data, 0x70, 4, "M2 materials")
    materials = [
        {"flags": u16(data, material_offset + i * 4), "blend": u16(data, material_offset + i * 4 + 2)}
        for i in range(material_count)
    ]
    combo_count, combo_offset = array(data, 0x80, 2, "M2 texture combos")
    texture_combos = [u16(data, combo_offset + i * 2) for i in range(combo_count)]
    return {
        "data": data, "positions": positions, "normals": normals, "uv0": uv0,
        "textures": textures, "materials": materials, "texture_combos": texture_combos,
        "skin_profiles": u32(data, 0x44),
    }


def parse_skin(path):
    data = Path(path).read_bytes()
    if len(data) < 48 or data[:4] != b"SKIN":
        raise ConversionError(f"{path} is not a WotLK skin profile")
    vertex_count, vertex_offset = array(data, 4, 2, "skin vertex lookup")
    index_count, index_offset = array(data, 12, 2, "skin indices")
    section_count, section_offset = array(data, 28, 48, "skin sections")
    batch_count, batch_offset = array(data, 36, 24, "skin batches")
    vertices = [u16(data, vertex_offset + i * 2) for i in range(vertex_count)]
    indices = [u16(data, index_offset + i * 2) for i in range(index_count)]
    sections = []
    for i in range(section_count):
        base = section_offset + i * 48
        level = u16(data, base + 2)
        sections.append({
            "id": u16(data, base), "index_start": u16(data, base + 8) | (level << 16),
            "index_count": u16(data, base + 10),
        })
    batches = []
    for i in range(batch_count):
        base = batch_offset + i * 24
        batches.append({
            "section": u16(data, base + 4), "material": u16(data, base + 10),
            "layer": u16(data, base + 12), "texture_count": u16(data, base + 14),
            "texture_combo": u16(data, base + 16),
        })
    return {"vertices": vertices, "indices": indices, "sections": sections, "batches": batches}


def resolve_texture(texture, display, model_path):
    texture_type = texture["type"]
    if texture_type == 0:
        name = texture["name"]
    elif texture_type == 1 and display.get("extra"):
        name = "Textures/BakedNpcTextures/" + display["extra"]["bake_name"]
    elif texture_type == 6 and display.get("extra"):
        name = display["extra"]["hair_texture"]
    elif texture_type in (11, 12, 13):
        name = display["textures"][texture_type - 11]
    else:
        return None
    if not name:
        return None
    name = name.replace("\\", "/")
    if "/" not in name:
        name = str(PureWindowsPath(model_path).parent / name).replace("\\", "/")
    if not name.lower().endswith(".blp"):
        name += ".blp"
    return name


class GLB:
    def __init__(self):
        self.binary = bytearray()
        self.views = []
        self.accessors = []

    def add_view(self, payload, target=None):
        while len(self.binary) % 4:
            self.binary.append(0)
        offset = len(self.binary)
        self.binary.extend(payload)
        view = {"buffer": 0, "byteOffset": offset, "byteLength": len(payload)}
        if target:
            view["target"] = target
        self.views.append(view)
        return len(self.views) - 1

    def add_accessor(self, payload, component_type, count, kind, target, minimum=None, maximum=None):
        view = self.add_view(payload, target)
        accessor = {"bufferView": view, "componentType": component_type, "count": count, "type": kind}
        if minimum is not None:
            accessor["min"] = minimum
            accessor["max"] = maximum
        self.accessors.append(accessor)
        return len(self.accessors) - 1

    def write(self, path, document):
        document["buffers"] = [{"byteLength": len(self.binary)}]
        document["bufferViews"] = self.views
        document["accessors"] = self.accessors
        raw_json = json.dumps(document, separators=(",", ":")).encode()
        raw_json += b" " * ((4 - len(raw_json) % 4) % 4)
        raw_bin = bytes(self.binary) + b"\0" * ((4 - len(self.binary) % 4) % 4)
        total = 12 + 8 + len(raw_json) + 8 + len(raw_bin)
        output = struct.pack("<4sII", b"glTF", 2, total)
        output += struct.pack("<I4s", len(raw_json), b"JSON") + raw_json
        output += struct.pack("<I4s", len(raw_bin), b"BIN\0") + raw_bin
        Path(path).write_bytes(output)


def convert(display_id, dbc_dir, client, locale, output_dir, keep_work=False, allow_composite=False):
    display = resolve_display(dbc_dir, display_id)
    if display.get("extra") and not display["extra"].get("bake_name") and not allow_composite:
        raise ConversionError(f"display {display_id} has no baked NPC texture; use --allow-composite for a diagnostic export")

    work = Path(tempfile.mkdtemp(prefix=f"forgekeeper-{display_id}-"))
    warnings = []
    if display.get("extra", {}).get("attachment_items"):
        warnings.append("equipment attachment models are not yet included: " + ", ".join(map(str, display["extra"]["attachment_items"])))
    try:
        extractor = Extractor(client, locale, work)
        model_file = extractor.extract(display["model_path"])
        skin_path = str(PureWindowsPath(display["model_path"]).with_suffix("")) + "00.skin"
        skin_file = extractor.extract(skin_path)
        m2, skin = parse_m2(model_file), parse_skin(skin_file)
        if not m2["positions"] or not skin["sections"]:
            raise ConversionError("model contains no renderable geometry")

        glb = GLB()
        position_bytes = b"".join(struct.pack("<fff", *v) for v in m2["positions"])
        normal_bytes = b"".join(struct.pack("<fff", *v) for v in m2["normals"])
        uv_bytes = b"".join(struct.pack("<ff", *v) for v in m2["uv0"])
        mins = [min(v[i] for v in m2["positions"]) for i in range(3)]
        maxs = [max(v[i] for v in m2["positions"]) for i in range(3)]
        position_accessor = glb.add_accessor(position_bytes, 5126, len(m2["positions"]), "VEC3", 34962, mins, maxs)
        normal_accessor = glb.add_accessor(normal_bytes, 5126, len(m2["normals"]), "VEC3", 34962)
        uv_accessor = glb.add_accessor(uv_bytes, 5126, len(m2["uv0"]), "VEC2", 34962)

        document = {
            "asset": {"version": "2.0", "generator": "Forgekeeper WotLK static M2 converter"},
            "scene": 0, "scenes": [{"nodes": [0]}], "nodes": [{"mesh": 0, "name": f"Display_{display_id}"}],
            "meshes": [{"name": Path(display["model_path"]).stem, "primitives": []}],
            "materials": [], "textures": [], "images": [], "samplers": [],
            "extras": {"displayId": display_id, "modelPath": display["model_path"], "staticBindPose": True},
        }
        material_cache = {}

        def material_for(batch):
            material_index = batch["material"]
            source_material = m2["materials"][material_index] if material_index < len(m2["materials"]) else {"flags": 0, "blend": 0}
            texture_index = None
            if batch["texture_count"]:
                combo = batch["texture_combo"]
                if combo < len(m2["texture_combos"]):
                    texture_index = m2["texture_combos"][combo]
                if batch["texture_count"] > 1:
                    warnings.append("multitexture batch exported with its first texture only")
            key = (material_index, texture_index)
            if key in material_cache:
                return material_cache[key]
            material = {
                "name": f"M2_Material_{material_index}",
                "pbrMetallicRoughness": {"baseColorFactor": [1, 1, 1, 1], "metallicFactor": 0, "roughnessFactor": 1},
                "doubleSided": bool(source_material["flags"] & 0x04),
            }
            blend = source_material["blend"]
            if blend == 1:
                material.update({"alphaMode": "MASK", "alphaCutoff": 0.878})
            elif blend >= 2:
                material["alphaMode"] = "BLEND"
                if blend not in (2,):
                    warnings.append(f"WoW blend mode {blend} approximated with glTF alpha blending")
            if texture_index is not None and texture_index < len(m2["textures"]):
                source_texture = m2["textures"][texture_index]
                internal = resolve_texture(source_texture, display, display["model_path"])
                if internal:
                    blp = extractor.extract(internal, required=False)
                    if blp:
                        try:
                            with Image.open(blp) as image:
                                png_path = work / f"texture-{len(document['images'])}.png"
                                image.convert("RGBA").save(png_path, "PNG", optimize=True)
                            image_view = glb.add_view(png_path.read_bytes())
                            image_id = len(document["images"])
                            document["images"].append({"bufferView": image_view, "mimeType": "image/png", "name": Path(internal).stem})
                            sampler_id = len(document["samplers"])
                            document["samplers"].append({
                                "magFilter": 9729, "minFilter": 9987,
                                "wrapS": 10497 if source_texture["flags"] & 1 else 33071,
                                "wrapT": 10497 if source_texture["flags"] & 2 else 33071,
                            })
                            gltf_texture = len(document["textures"])
                            document["textures"].append({"source": image_id, "sampler": sampler_id})
                            material["pbrMetallicRoughness"]["baseColorTexture"] = {"index": gltf_texture}
                        except Exception as error:
                            warnings.append(f"could not decode {internal}: {error}")
                    else:
                        warnings.append(f"texture not found: {internal}")
                else:
                    warnings.append(f"replaceable texture type {source_texture['type']} is not supported")
            document["materials"].append(material)
            result = len(document["materials"]) - 1
            material_cache[key] = result
            return result

        batches = skin["batches"] or [{"section": i, "material": 0, "layer": 0, "texture_count": 0, "texture_combo": 0} for i in range(len(skin["sections"]))]
        for batch in batches:
            if batch["section"] >= len(skin["sections"]):
                warnings.append("batch references an invalid skin section")
                continue
            section = skin["sections"][batch["section"]]
            if display.get("extra") and section["id"] not in display["extra"]["visible_geosets"]:
                continue
            start, end = section["index_start"], section["index_start"] + section["index_count"]
            if end > len(skin["indices"]):
                warnings.append("skin section has an invalid index range")
                continue
            indices = []
            for skin_index in skin["indices"][start:end]:
                if skin_index >= len(skin["vertices"]):
                    raise ConversionError("skin index references a missing vertex lookup")
                vertex = skin["vertices"][skin_index]
                if vertex >= len(m2["positions"]):
                    raise ConversionError("skin vertex lookup references a missing M2 vertex")
                indices.append(vertex)
            if len(indices) < 3:
                continue
            index_bytes = b"".join(struct.pack("<I", value) for value in indices)
            index_accessor = glb.add_accessor(index_bytes, 5125, len(indices), "SCALAR", 34963, [min(indices)], [max(indices)])
            document["meshes"][0]["primitives"].append({
                "attributes": {"POSITION": position_accessor, "NORMAL": normal_accessor, "TEXCOORD_0": uv_accessor},
                "indices": index_accessor, "material": material_for(batch), "mode": 4,
                "extras": {"skinSection": batch["section"], "geosetId": section["id"], "materialLayer": batch["layer"]},
            })

        if not document["meshes"][0]["primitives"]:
            raise ConversionError("no valid render batches were found")
        document["extras"]["warnings"] = sorted(set(warnings))
        output_dir = Path(output_dir)
        output_dir.mkdir(parents=True, exist_ok=True)
        output = output_dir / f"{display_id}.glb"
        glb.write(output, document)
        manifest = output_dir / f"{display_id}.json"
        manifest.write_text(json.dumps({**display, "output": str(output), "warnings": sorted(set(warnings))}, indent=2) + "\n")
        print(json.dumps({"status": "converted", "displayId": display_id, "output": str(output), "warnings": sorted(set(warnings))}, indent=2))
    finally:
        if keep_work:
            print(f"kept extracted work files at {work}", file=sys.stderr)
        else:
            shutil.rmtree(work, ignore_errors=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("display_ids", nargs="+", type=int, help="CreatureDisplayInfo.dbc display IDs")
    parser.add_argument("--dbc", default=os.environ.get("DBC_PATH", "/dbc"))
    parser.add_argument("--client", default=os.environ.get("WOW_CLIENT_PATH", "/client"))
    parser.add_argument("--locale", default=os.environ.get("WOW_LOCALE", "enUS"))
    parser.add_argument("--output", default=os.environ.get("MODEL_CACHE_PATH", "/models"))
    parser.add_argument("--allow-composite", action="store_true", help="export unsupported humanoid displays without composed textures")
    parser.add_argument("--keep-work", action="store_true")
    args = parser.parse_args()
    failures = 0
    for display_id in args.display_ids:
        try:
            convert(display_id, args.dbc, args.client, args.locale, args.output, args.keep_work, args.allow_composite)
        except Exception as error:
            failures += 1
            print(f"display {display_id}: {error}", file=sys.stderr)
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
