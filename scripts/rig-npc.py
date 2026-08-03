"""Rig npc.glb so villagers can swing arms and legs like the player (headless Blender).

npc.glb ships as ONE node / ONE mesh / 4 material primitives (Shoe, Pants,
Shirt, Skin) with NO skeleton and NO clips, so the wander loop could only ever
modulate the whole group (bob/roll/lift) — villagers glided with rigid bodies
while the player, whose player.glb carries a 7-bone rig, swung its limbs.

Measured from the GLB accessors (raw model space, glTF Y-up; Blender Z == glTF Y):

  Shoe   1 island   x +-0.085   z 0.030..0.090   (feet merged into one slab)
  Pants  1 island   x +-0.075   z 0.070..0.930   (legs merged, no midline verts)
  Shirt  3 islands  torso x +-0.142 z 0.880..1.380
                    arms  |x| 0.142..0.198  z 0.750..1.300
  Skin   1 island   x +-0.190   z 1.320..1.720   (head)

The arms are already separate boxes, but the legs are NOT: Pants and Shoe are
each a single box with no vertices at x=0, so weighting their halves to
counter-rotating bones would shear the box instead of producing two legs. This
script therefore SPLITS those two boxes down the middle first (duplicate the
island, then clamp one copy to each side of a small gap), then binds all eight
resulting parts to a 5-bone armature.

Bones use the SAME names as player.glb (armL/armR/legL/legR) so the runtime can
name-match them exactly like SimplePlayer.ensureLimbBones does. Weights are
rigid (1.0 to a single bone per island) — correct here because every body part
is a disconnected box, which is also how player.glb itself is weighted.

Draw calls are unchanged: the 4 primitives become 4 SkinnedMeshes sharing one
skeleton. Material names/order, part positions and total height are preserved,
so Island.dressNpc (palette swap by material name, eyes y1.56, hair y1.6, hats
y1.68) keeps working untouched.

RUNTIME REQUIREMENT: skinned models must be cloned with SkeletonUtils.clone —
a plain Object3D.clone(true) makes every villager share one skeleton. NPC.ts
does this.

Run (Blender 5.1 installed on this machine):
  & "C:\\Program Files\\Blender Foundation\\Blender 5.1\\blender.exe" `
      --background --python scripts/rig-npc.py

PIPELINE ORDER: this consumes the gap-fixed npc.glb. If fix-avatar-gaps.py is
ever re-run it restores the pristine UNRIGGED original, so re-run this script
afterwards. Idempotent: the unrigged input is kept in scripts/backup/ and
restored before each run, so re-running never double-splits the boxes.
"""

from pathlib import Path
import shutil

import bpy
import bmesh
from mathutils import Vector

REPO = Path(__file__).resolve().parents[1]
MODELS = REPO / "public" / "assets" / "models"
BACKUP = REPO / "scripts" / "backup"

# Split geometry: half-gap between the two legs / two shoes.
LEG_GAP = 0.012
# Bone anchors (Blender space, z == glTF y).
HIP_Z = 0.930          # pants top == hip joint
FOOT_Z = 0.030         # shoe bottom
SHOULDER_Z = 1.300     # arm top == shoulder joint
HAND_Z = 0.750         # arm bottom
ARM_X = 0.170          # centre of the arm boxes (|x| 0.142..0.198)
ARM_INNER_X = 0.142    # arm inner face == torso side face (they abut)
TORSO_MIN_Z = 0.880    # torso bottom; the arm boxes hang to 0.750


def wipe() -> None:
    bpy.ops.wm.read_factory_settings(use_empty=True)


def ensure_pristine(path: Path) -> None:
    """First run: back up the unrigged model. Later runs: restore it."""
    BACKUP.mkdir(parents=True, exist_ok=True)
    bak = BACKUP / (path.name + ".unrigged")
    if bak.exists():
        shutil.copy2(bak, path)
    else:
        shutil.copy2(path, bak)


def material_slots(ob) -> dict[str, int]:
    """Lowercased material name -> slot index."""
    return {(m.name or "").lower(): i for i, m in enumerate(ob.data.materials)}


def slot_for(slots: dict[str, int], needle: str) -> int:
    for name, idx in slots.items():
        if needle in name:
            return idx
    raise AssertionError(f"no material matching {needle!r} in {sorted(slots)}")


def faces_geom(bm, mat_idx: int):
    """All faces of one material slot plus their verts/edges (dedup'd)."""
    faces = [f for f in bm.faces if f.material_index == mat_idx]
    assert faces, f"no faces for material slot {mat_idx}"
    verts = {v for f in faces for v in f.verts}
    edges = {e for f in faces for e in f.edges}
    return faces, verts, edges


def flip_toes_forward(bm, mat_idx: int) -> None:
    """Mirror the shoe slab front-to-back so the toes point the way the
    villager walks.

    The authored shoes run z -0.080..+0.040 (Blender y == glTF -z ... in the
    imported Z-up space the depth axis is y): they stick out 0.08 BEHIND the
    ankle and only 0.04 in front, i.e. they are on backwards. The face (eyes
    at glTF z +0.19) and the wander loop's heading both point the other way,
    so once the legs started swinging the gait read as walking backwards.
    Every other part is symmetric about the depth axis, so this is the only
    piece that needed turning around. Mirroring reverses winding, so the
    faces are flipped back to keep normals outward.
    """
    faces, verts, _edges = faces_geom(bm, mat_idx)
    for v in verts:
        v.co.y = -v.co.y
    bmesh.ops.reverse_faces(bm, faces=faces)


def split_lr(bm, mat_idx: int) -> None:
    """Turn one centred box into two, either side of a 2*LEG_GAP channel.

    The glTF importer does NOT weld these flat-shaded boxes (every face is its
    own vertex island — the trap documented in fix-avatar-gaps.py), so parts
    are identified by MATERIAL, which is also the only thing that separates the
    overlapping pants top from the torso bottom.

    The original keeps the +x half (its -x verts clamp to +LEG_GAP); a
    duplicate becomes the -x half. The boxes have no vertices at x=0, so
    clamping a side face inward never degenerates it.
    """
    faces, verts, edges = faces_geom(bm, mat_idx)
    res = bmesh.ops.duplicate(bm, geom=list(faces) + list(edges) + list(verts))
    dupe_verts = [g for g in res["geom"] if isinstance(g, bmesh.types.BMVert)]
    for v in verts:  # original -> +x leg
        if v.co.x < LEG_GAP:
            v.co.x = LEG_GAP
    for v in dupe_verts:  # copy -> -x leg
        if v.co.x > -LEG_GAP:
            v.co.x = -LEG_GAP


def classify_shirt_face(f) -> str:
    """Shirt primitive -> torso (root) or one of the arm bones.

    The torso box (|x| <= 0.142, z 0.880..1.380) and each arm box (|x|
    0.142..0.198, z 0.750..1.300) ABUT at |x| = 0.142, so x alone cannot
    separate the torso's side face from the arm's inner face — classifying
    per-vertex tore the torso in half. Faces are unambiguous: only those two
    sit at |x| ~= 0.142, and the arm box hangs 0.13 lower, so the face's
    minimum z tells them apart.
    """
    cx = f.calc_center_median().x
    if abs(cx) < ARM_INNER_X - 0.003:
        return "root"  # torso front/back/top/bottom + its own side faces
    if abs(cx) > ARM_INNER_X + 0.003:
        return "armL" if cx > 0 else "armR"
    zmin = min(v.co.z for v in f.verts)
    if zmin < TORSO_MIN_Z - 0.03:
        return "armL" if cx > 0 else "armR"  # arm inner face (reaches z 0.75)
    return "root"  # torso side face (stops at z 0.88)


def build_armature(name: str):
    arm_data = bpy.data.armatures.new("NpcRig")
    arm_obj = bpy.data.objects.new(name, arm_data)
    bpy.context.scene.collection.objects.link(arm_obj)
    bpy.context.view_layer.objects.active = arm_obj
    bpy.ops.object.mode_set(mode="EDIT")
    spec = {
        "root": ((0.0, 0.0, 0.90), (0.0, 0.0, 1.20)),
        "legL": ((+0.0435, 0.0, HIP_Z), (+0.0435, 0.0, FOOT_Z)),
        "legR": ((-0.0435, 0.0, HIP_Z), (-0.0435, 0.0, FOOT_Z)),
        "armL": ((+ARM_X, 0.0, SHOULDER_Z), (+ARM_X, 0.0, HAND_Z)),
        "armR": ((-ARM_X, 0.0, SHOULDER_Z), (-ARM_X, 0.0, HAND_Z)),
    }
    root = None
    for bone_name, (head, tail) in spec.items():
        b = arm_data.edit_bones.new(bone_name)
        b.head = Vector(head)
        b.tail = Vector(tail)
        b.roll = 0.0
        if bone_name == "root":
            root = b
        else:
            b.parent = root
            b.use_connect = False
    bpy.ops.object.mode_set(mode="OBJECT")
    return arm_obj


def rig_npc() -> None:
    src = MODELS / "npc.glb"
    ensure_pristine(src)
    wipe()
    bpy.ops.import_scene.gltf(filepath=str(src), merge_vertices=True)
    npc = bpy.data.objects.get("Npc")
    assert npc is not None and npc.type == "MESH", "expected mesh object 'Npc' after import"
    assert not npc.vertex_groups, "npc.glb already rigged - restore the unrigged backup"

    slots = material_slots(npc)
    print("material slots:", slots)
    shoe_i, pants_i = slot_for(slots, "shoe"), slot_for(slots, "pants")
    shirt_i, skin_i = slot_for(slots, "shirt"), slot_for(slots, "skin")

    # 1. Turn the backwards shoes around, then split the single pants box and
    #    single shoe slab into left/right parts.
    bm = bmesh.new()
    bm.from_mesh(npc.data)
    flip_toes_forward(bm, shoe_i)
    for mat_idx in (pants_i, shoe_i):
        split_lr(bm, mat_idx)
    bm.to_mesh(npc.data)
    bm.free()
    npc.data.update()

    # 2. Bone per vertex, from (material, position). Material is what keeps the
    #    pants top from being confused with the torso bottom where they overlap.
    bm = bmesh.new()
    bm.from_mesh(npc.data)
    bm.verts.ensure_lookup_table()
    groups: dict[str, list[int]] = {}
    for f in bm.faces:
        if f.material_index in (pants_i, shoe_i):
            # One box per side after the split — sign of x is unambiguous.
            bone = "legL" if f.calc_center_median().x > 0 else "legR"
        elif f.material_index == shirt_i:
            bone = classify_shirt_face(f)
        else:  # head (Skin) — carried by the root bone
            bone = "root"
        for v in f.verts:
            groups.setdefault(bone, []).append(v.index)
    bm.free()
    print("verts per bone:", {k: len(set(v)) for k, v in sorted(groups.items())})
    assert skin_i is not None
    for needed in ("legL", "legR", "armL", "armR", "root"):
        assert groups.get(needed), f"no vertices classified as {needed}"

    # 3. Armature + rigid weights (1.0 to one bone per island).
    arm_obj = build_armature("NpcRig")
    for bone_name, idxs in groups.items():
        vg = npc.vertex_groups.new(name=bone_name)
        vg.add(sorted(set(idxs)), 1.0, "REPLACE")
    mod = npc.modifiers.new(name="Armature", type="ARMATURE")
    mod.object = arm_obj
    npc.parent = arm_obj

    # 4. Export. Skins on, no animations (the swing is procedural at runtime).
    want = {
        "filepath": str(src),
        "export_format": "GLB",
        "export_yup": True,
        "export_apply": False,
        "export_animations": False,
        "export_skins": True,
        "export_def_bones": False,
        "export_materials": "EXPORT",
        "export_cameras": False,
        "export_lights": False,
        "export_extras": False,
        "export_morph": False,
        "export_draco_mesh_compression_enable": False,
        "use_selection": False,
    }
    props = bpy.ops.export_scene.gltf.get_rna_type().properties.keys()
    bpy.ops.export_scene.gltf(**{k: v for k, v in want.items() if k in props})
    print(f"wrote {src}")


if __name__ == "__main__":
    rig_npc()
    print("Done. Verify per CLAUDE.md visual protocol: npm run dev (port 5173),")
    print("screenshot a walking villager (arms/legs swinging) and an idle one.")
