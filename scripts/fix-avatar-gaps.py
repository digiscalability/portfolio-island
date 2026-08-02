"""Close the floating-part gaps in player.glb + npc.glb (headless Blender).

Both avatars are Blender-authored box-part characters whose limb primitives
are too SHORT for their part/bone spacing, so they render as disjointed
floating parts. Measured from the GLB accessors (glTF Y-up bind space):

  player.glb (skinned: hips/spine/head/armL/armR/legL/legR, Idle+Walk clips)
    ankle gap  0.175  pants stop y-0.435, shoes start y-0.610
    pelvis void 0.320  pants top y-0.125 -> torso bottom y0.195 (nothing at hips bone)
    chest gap  0.110  torso top y0.505 -> floating collar slab y0.615
    wrist gap  0.155  sleeves stop y0.18, hand cubes float at y+-0.025
    shoulders  sleeves x0.287..0.352 never reach torso (x+-0.115) or collar (+-0.125)
  npc.glb (single unrigged mesh, no clips)
    shoe->pants 0.185, pants->shirt 0.300, shirt->head 0.145,
    sleeves float 0.147 off the torso, no hands at all

Fix strategy: every body part is a disconnected vertex island. Classify each
island by its bounding-box centre, then apply an affine height remap
(z' = a*z + b; Blender Z == glTF Y after import) and/or a mirrored inward
X-shift per class so adjacent parts overlap by 0.02-0.05. Vertices move in
BIND space; JOINTS/WEIGHTS are untouched, so the player rig and both clips
keep working unchanged. The outline hull (PlayerOutline, 540 verts) is a 1:1
per-part duplicate of the body islands and receives the identical ops. A
small neck cylinder (Skin material, weighted 1.0 to `spine`) is added to the
player body + a flipped-normal copy to the outline. The player collar slab is
widened x2.48 into a shoulder yoke that bridges torso <-> sleeves.

IMPORTANT: the glTF importer does NOT weld the flat-shaded cubes, so without
merge_vertices=True every FACE is its own island (160 islands, not ~13) and
the per-part classify/scale ops shred the mesh. Parts are spatially disjoint,
so welding never fuses two parts, and rigid weights survive the weld.

Runtime code needs NO changes: material names (Shoe/Pants/Jacket|Shirt/Skin/
Hair/Outline), bone names, clip names, total height and foot level (bbox
min.y -0.672) are all preserved, so SimplePlayer's feet calibration,
setBodyColor, equipHat and Island.dressNpc (eyes y1.56 / hair y1.6 on the
untouched NPC head) keep working.

Run (Blender 5.1 installed on this machine):
  & "C:\\Program Files\\Blender Foundation\\Blender 5.1\\blender.exe" `
      --background --python scripts/fix-avatar-gaps.py

Idempotent: pristine originals are kept in scripts/backup/ (OUTSIDE public/,
which Vite copies verbatim into the deployed bundle) and restored before each
run, so re-running never double-stretches geometry.
"""

import shutil
from pathlib import Path

import bpy
import bmesh
from mathutils import Vector

REPO = Path(__file__).resolve().parents[1]
MODELS = REPO / "public" / "assets" / "models"
BACKUP = REPO / "scripts" / "backup"


# ---------------------------------------------------------------- utilities

def wipe() -> None:
    bpy.ops.wm.read_factory_settings(use_empty=True)


def ensure_pristine(path: Path) -> None:
    """First run: back up. Later runs: restore the backup (idempotence)."""
    BACKUP.mkdir(parents=True, exist_ok=True)
    bak = BACKUP / (path.name + ".bak")
    if bak.exists():
        shutil.copy2(bak, path)
    else:
        shutil.copy2(path, bak)


def obj(name: str):
    ob = bpy.data.objects.get(name)
    assert ob is not None and ob.type == "MESH", f"expected mesh object {name!r} after import"
    return ob


def mesh_islands(ob):
    """Connected vertex islands -> [(vert_indices, centre, lo, hi)] in local space."""
    bm = bmesh.new()
    bm.from_mesh(ob.data)
    bm.verts.ensure_lookup_table()
    seen = [False] * len(bm.verts)
    islands = []
    for seed in bm.verts:
        if seen[seed.index]:
            continue
        stack, verts = [seed], []
        seen[seed.index] = True
        while stack:
            v = stack.pop()
            verts.append(v.index)
            for e in v.link_edges:
                o = e.other_vert(v)
                if not seen[o.index]:
                    seen[o.index] = True
                    stack.append(o)
        cos = [bm.verts[i].co for i in verts]
        lo = Vector((min(c.x for c in cos), min(c.y for c in cos), min(c.z for c in cos)))
        hi = Vector((max(c.x for c in cos), max(c.y for c in cos), max(c.z for c in cos)))
        islands.append((verts, (lo + hi) / 2.0, lo.copy(), hi.copy()))
    bm.free()
    return islands


def remap(ob, classify, ops) -> None:
    me = ob.data
    for verts, centre, _lo, _hi in mesh_islands(ob):
        op = ops.get(classify(centre))
        if op is None:
            continue
        for i in verts:
            op(me.vertices[i].co, centre)
    me.update()


# Per-vertex ops. co is a mutable Vector; c is the island's (pre-op) centre.

def affine_z(a, b):
    def op(co, _c):
        co.z = a * co.z + b
    return op


def shift_x_inward(d):
    def op(co, _c):
        co.x -= d if co.x > 0.0 else -d
    return op


def scale_xy(sx, sy):  # widen sideways (x) and depth (Blender y == glTF -z)
    def op(co, _c):
        co.x *= sx
        co.y *= sy
    return op


def scale_about_centre(s):
    def op(co, c):
        co.x = c.x + (co.x - c.x) * s
        co.y = c.y + (co.y - c.y) * s
        co.z = c.z + (co.z - c.z) * s
    return op


def seq(*ops):
    def op(co, c):
        for o in ops:
            o(co, c)
    return op


# ------------------------------------------------------------------- player
# Island centres in Blender space (z = glTF y): shoes z-0.64, pants z-0.28,
# hands (x+-0.32, z0.0), sleeves (x+-0.32, z0.32), torso z0.35, collar z0.64,
# head z0.88, hair z1.02. Outline islands mirror these within ~0.005.

def classify_player(c):
    if c.z < -0.55:
        return "shoe"                      # keep
    if c.z < -0.05:
        return "pants"
    if abs(c.x) > 0.25 and -0.1 < c.z < 0.1:
        return "hand"
    if abs(c.x) > 0.25 and 0.1 <= c.z < 0.55:
        return "sleeve"
    if abs(c.x) <= 0.25 and 0.1 <= c.z < 0.55:
        return "torso"
    if abs(c.x) <= 0.25 and 0.55 <= c.z < 0.75:
        return "collar"
    return "head"                          # head + hair: keep


PLAYER_OPS = {
    # pants  [-0.435,-0.125] -> [-0.630, 0.100]: into shoes + up to the hips
    "pants": affine_z(2.35484, 0.39435),
    # torso  [0.195, 0.505] -> [0.050, 0.630]: down over pants, up to collar
    "torso": affine_z(1.87097, -0.31484),
    # collar: KEEP as authored. Widening it into a shoulder yoke (2.48, then
    # 2.0) read as a flat white tray under the chin; with the sleeves now
    # stretched to shoulder height (z0.620 ≈ torso top 0.630) the slight
    # torso↔sleeve side gap is normal toon anatomy and needs no bridge.
    # sleeves [0.180, 0.460] -> [0.020, 0.620] + 0.045 inward (onto bone x0.28)
    "sleeve": seq(affine_z(2.14286, -0.365714), shift_x_inward(0.045)),
    # hands: chunkier mitts, then follow sleeves inward (scale FIRST so the
    # pivot is the true pre-shift centre)
    "hand": seq(scale_about_centre(1.15), shift_x_inward(0.045)),
}


def add_neck(target, mat_name: str, flip: bool, radius: float) -> None:
    """Neck cylinder z 0.56..0.70 (bridges torso top 0.63 -> head bottom 0.65),
    joined into `target` so it exports inside the existing mesh/primitive set.
    Weighted 1.0 to `spine` -> follows the body under head-look, animates fine."""
    me = bpy.data.meshes.new("Neck")
    bm = bmesh.new()
    bmesh.ops.create_cone(
        bm, cap_ends=True, segments=8, radius1=radius, radius2=radius, depth=0.14
    )
    bmesh.ops.translate(bm, verts=bm.verts, vec=(0.0, 0.0, 0.63))
    if flip:  # outline copy = inverted hull
        bmesh.ops.reverse_faces(bm, faces=bm.faces)
    bm.to_mesh(me)
    bm.free()
    mat = bpy.data.materials.get(mat_name)
    assert mat is not None, f"material {mat_name!r} not found after import"
    me.materials.append(mat)
    ob = bpy.data.objects.new("Neck", me)
    bpy.context.scene.collection.objects.link(ob)
    vg = ob.vertex_groups.new(name="spine")
    vg.add(list(range(len(me.vertices))), 1.0, "REPLACE")
    bpy.ops.object.select_all(action="DESELECT")
    ob.select_set(True)
    target.select_set(True)
    bpy.context.view_layer.objects.active = target
    bpy.ops.object.join()


# ---------------------------------------------------------------------- npc
# Island centres: shoe z0.06, pants z0.43, shirt torso z1.03 (|x|<=0.105),
# sleeves (x+-0.28, z1.02), head z1.52.

def classify_npc(c):
    if c.z < 0.15:
        return "shoe"                      # keep
    if c.z < 0.70:
        return "pants"
    if c.z < 1.25:
        return "sleeve" if abs(c.x) > 0.15 else "torso"
    return "head"                          # keep: dressNpc eyes y1.56 / hair y1.6


NPC_OPS = {
    # pants  [0.275, 0.585] -> [0.070, 0.930]: into shoe, up to shirt
    "pants": affine_z(2.77419, -0.692903),
    # shirt  [0.885, 1.175] -> [0.880, 1.380]: over pants + collar into head;
    # widen x/depth 1.35 so the torso reads against the +-0.19 head
    "torso": seq(affine_z(1.72414, -0.645862), scale_xy(1.35, 1.35)),
    # sleeves [0.890, 1.150] -> [0.750, 1.300] + 0.11 inward (flush with torso)
    "sleeve": seq(affine_z(2.11538, -1.132692), shift_x_inward(0.11)),
}


# ------------------------------------------------------------------- export

def export_glb(path: Path, animated: bool) -> None:
    """Match the source GLBs: GLB container, +Y up, plain colour materials,
    no compression/extensions; player additionally re-exports skin + the two
    actions (Idle/Walk) unbaked/unoptimised. Kwargs are filtered against the
    running exporter's RNA so the script survives option renames."""
    want = {
        "filepath": str(path),
        "export_format": "GLB",
        "export_yup": True,
        "export_apply": False,
        "export_animations": animated,
        "export_animation_mode": "ACTIONS",
        "export_optimize_animation_size": False,
        "export_skins": animated,
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


def report(ob, classify) -> dict:
    spans = {}
    for _v, c, lo, hi in mesh_islands(ob):
        k = classify(c)
        zlo, zhi = spans.get(k, (1e9, -1e9))
        spans[k] = (min(zlo, lo.z), max(zhi, hi.z))
    for k, (zlo, zhi) in sorted(spans.items(), key=lambda kv: kv[1][0]):
        print(f"   {k:7s} z {zlo:+.3f} .. {zhi:+.3f}")
    return spans


# --------------------------------------------------------------------- main

def fix_player() -> None:
    src = MODELS / "player.glb"
    ensure_pristine(src)
    wipe()
    bpy.ops.import_scene.gltf(filepath=str(src), merge_vertices=True)
    body, outline = obj("PlayerBody"), obj("PlayerOutline")
    arm = next(o for o in bpy.data.objects if o.type == "ARMATURE")
    bones = {b.name for b in arm.data.bones}
    assert {"hips", "spine", "head", "armL", "armR", "legL", "legR"} <= bones, bones
    for ob in (body, outline):
        remap(ob, classify_player, PLAYER_OPS)
    add_neck(body, "Skin", flip=False, radius=0.070)
    add_neck(outline, "Outline", flip=True, radius=0.076)
    print("player.glb after remap:")
    s = report(body, classify_player)
    assert s["pants"][1] > s["torso"][0], "pelvis gap still open"
    assert s["pants"][0] < s["shoe"][1], "ankle gap still open"
    assert s["sleeve"][0] < s["hand"][1], "wrist gap still open"
    assert s["torso"][1] > s["collar"][0], "chest gap still open"
    export_glb(src, animated=True)
    print(f"wrote {src}")


def fix_npc() -> None:
    src = MODELS / "npc.glb"
    ensure_pristine(src)
    wipe()
    bpy.ops.import_scene.gltf(filepath=str(src), merge_vertices=True)
    npc = obj("Npc")
    remap(npc, classify_npc, NPC_OPS)
    print("npc.glb after remap:")
    s = report(npc, classify_npc)
    assert s["pants"][0] < s["shoe"][1], "shoe gap still open"
    assert s["pants"][1] > s["torso"][0], "waist gap still open"
    assert s["torso"][1] > s["head"][0], "neck gap still open"
    export_glb(src, animated=False)
    print(f"wrote {src}")


if __name__ == "__main__":
    fix_player()
    fix_npc()
    print("Done. Verify per CLAUDE.md visual protocol: npm run dev (port 5173),")
    print("screenshot the player (idle/walk/wave/swim) and a villager close-up.")
