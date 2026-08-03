"""Round the avatars' heads and give the player a face (headless Blender).

"Improve the head... improve the face." Two changes, both bbox-exact:

HEAD: both avatars' heads are 80-tri icospheres whose SILHOUETTE is visibly
polygonal even after smooth shading. Each head face is subdivided once and
the new midpoint verts are projected onto the head's own bounding ellipsoid
(verts transformed into unit-sphere space about the head centre, normalised,
transformed back). Original verts — including the poles that define the bbox
— never move, so total height, hat anchors, dressNpc eye/hair heights and
the name-pill clearance all stay bit-exact. 80 -> 320 tris per head.
PlayerOutline's head copy gets the IDENTICAL treatment: a rounded body head
bulges up to ~0.011 at old facet centres, which would poke through the
0.005-ish hull shell if the hull stayed 80-tri.

FACE: the GLB player has NO face — the procedural fallback avatar in
SimplePlayer.ts (eyes + white pupil highlights + smile) loses all of it the
moment player.glb loads. This bakes the same face into the GLB, matching the
fallback's proportions scaled to the GLB head (r 0.23 vs 0.22):
  eyes            icosphere r 0.036 at (+-0.075, -0.205, 0.920), new "Eye"
                  material (0x1a1a1a)
  eye highlights  icosphere r 0.013 at (+-0.061, -0.226, 0.934), new
                  "EyeShine" material (white) — offset toward the nose/top
                  like the fallback's
  smile           half-torus (major 0.042, minor 0.010) at (0, -0.212, 0.816)
                  opening upward, "Eye" material
Face geometry is weighted 1.0 to the `head` bone so it rides head-look and
the walk bob. The face sits on the -Y side: the model faces glTF +Z and the
importer maps that to Blender -Y (same convention fix-player-toes.py
documents for the shoes).

Materials "Eye"/"EyeShine" are NEW names: SimplePlayer.setBodyColor matches
known names exactly (Jacket/Skin/Pants/Shoe/Hair) and ignores everything
else, so the face never gets recoloured to skin tone. The NPC gets NO baked
face — Island.dressNpc already gives villagers per-persona eyes at runtime.

The BEARD is not touched here because it is not in the GLB: it is the
runtime hair_cap sphere in SimplePlayer.ts, whose sub-equator rim wraps the
lower face (verified by toggling it live). That fix is a TS change alongside
this script.

Run (Blender 5.1 installed on this machine):
  & "C:\\Program Files\\Blender Foundation\\Blender 5.1\\blender.exe" `
      --background --python scripts/reshape-avatar-face.py

PIPELINE ORDER (slot 2 of 6):
  fix-avatar-gaps -> THIS -> fix-player-toes -> rig-npc ->
  soften-avatar-silhouette -> smooth-avatar-shading
Idempotent the restore-first way (.preface snapshots) — subdividing twice
would quadruple the head, so each run restores the pre-face input.
"""

from pathlib import Path
import math
import shutil

import bpy
import bmesh
from mathutils import Vector

REPO = Path(__file__).resolve().parents[1]
MODELS = REPO / "public" / "assets" / "models"
BACKUP = REPO / "scripts" / "backup"

WELD_DIST = 1e-5

# Player head ellipsoid (measured from the pristine model, Blender space).
P_HEAD_C = Vector((0.0, 0.0, 0.880))
P_HEAD_R = Vector((0.219, 0.230, 0.230))
# NPC head.
N_HEAD_C = Vector((0.0, 0.0, 1.520))
N_HEAD_R = Vector((0.190, 0.200, 0.200))

# Hair helmet: duplicated head faces pushed out along the ellipsoid normal,
# on the Hair material — replaces the runtime hair_cap sphere, which could
# not hug the rounded head (its rim always poked out as a beard/band).
# Selection in unit-ellipsoid space about the head centre: the BACK of the
# head (u_y toward +y; the face is on -y) from just below the equator up to
# where the authored fringe takes over.
HELMET_UY_MIN = 0.12
HELMET_UZ_MIN = -0.15
HELMET_TOP_UZ = 0.55   # whole crown above this, any u_y — tucks UNDER the
                       # authored fringe (fringe sits ~0.015 proud, helmet
                       # 0.010, so no z-fight) and fills its white notches
HELMET_OFFSET = 0.010

EYE_R = 0.036
EYE_POS = 0.075, -0.205, 0.920   # +-x, y, z
SHINE_R = 0.013
SHINE_POS = 0.061, -0.226, 0.934
MOUTH_C = Vector((0.0, -0.212, 0.816))
MOUTH_MAJOR = 0.042
MOUTH_MINOR = 0.010
MOUTH_SEGS = 8   # arc segments
MOUTH_RING = 6   # cross-section segments


def wipe() -> None:
    bpy.ops.wm.read_factory_settings(use_empty=True)


def ensure_preface(path: Path) -> None:
    BACKUP.mkdir(parents=True, exist_ok=True)
    bak = BACKUP / (path.name + ".preface")
    if bak.exists():
        shutil.copy2(bak, path)
    else:
        shutil.copy2(path, bak)


def weld(bm) -> None:
    bmesh.ops.remove_doubles(bm, verts=bm.verts[:], dist=WELD_DIST)
    bm.normal_update()


def round_head(bm, centre: Vector, radii: Vector) -> int:
    """Subdivide the head ISLAND once and push midpoints to the ellipsoid.

    The head is selected as a connected component, not by material or z
    window — a z window also catches the neck cap (player) or collar top
    (outline hull), whose verts would then be yanked onto the head surface.
    The head island is the 80-face part whose bbox centre is nearest the
    known head centre.
    """
    seen = set()
    parts = []
    for seed in bm.faces:
        if seed.index in seen:
            continue
        stack, faces = [seed], []
        seen.add(seed.index)
        while stack:
            f = stack.pop()
            faces.append(f)
            for e in f.edges:
                for o in e.link_faces:
                    if o.index not in seen:
                        seen.add(o.index)
                        stack.append(o)
        parts.append(faces)

    def part_centre(faces):
        vs = {v for f in faces for v in f.verts}
        lo = Vector((min(v.co[i] for v in vs) for i in range(3)))
        hi = Vector((max(v.co[i] for v in vs) for i in range(3)))
        return (lo + hi) / 2.0

    head_faces = min(parts, key=lambda p: (part_centre(p) - centre).length)
    assert len(head_faces) == 80, f"head island has {len(head_faces)} faces, expected 80"
    assert (part_centre(head_faces) - centre).length < 0.1, "nearest island is not at the head centre"

    before = {v.index for f in head_faces for v in f.verts}
    edges = list({e for f in head_faces for e in f.edges})
    new_geom = bmesh.ops.subdivide_edges(bm, edges=edges, cuts=1, use_grid_fill=True)
    bm.normal_update()
    bm.verts.ensure_lookup_table()

    moved = 0
    for el in new_geom["geom_inner"] + new_geom["geom_split"]:
        if not isinstance(el, bmesh.types.BMVert):
            continue
        v = el
        u = Vector(((v.co.x - centre.x) / radii.x,
                    (v.co.y - centre.y) / radii.y,
                    (v.co.z - centre.z) / radii.z))
        L = u.length
        if L < 0.5 or L > 1.5:
            continue
        u.normalize()
        v.co = Vector((centre.x + u.x * radii.x,
                       centre.y + u.y * radii.y,
                       centre.z + u.z * radii.z))
        moved += 1
    return moved


def add_hair_helmet(bm, centre: Vector, radii: Vector, hair_index: int) -> int:
    """Duplicate the back-of-head faces outward as a hair shell."""
    def u_of(co):
        return Vector(((co.x - centre.x) / radii.x,
                       (co.y - centre.y) / radii.y,
                       (co.z - centre.z) / radii.z))

    sel = []
    for f in bm.faces:
        c = f.calc_center_median()
        u = u_of(c)
        if abs(u.length - 1.0) > 0.25:
            continue  # not on the head surface
        back = u.y > HELMET_UY_MIN and u.z > HELMET_UZ_MIN
        crown = u.z > HELMET_TOP_UZ
        if back or crown:
            sel.append(f)
    assert sel, "no helmet faces selected"

    dup = bmesh.ops.duplicate(bm, geom=sel)
    new_faces = [g for g in dup["geom"] if isinstance(g, bmesh.types.BMFace)]
    new_verts = {v for f in new_faces for v in f.verts}
    for v in new_verts:
        u = u_of(v.co)
        L = u.length or 1.0
        n = Vector((u.x / L * radii.y, u.y / L * radii.x, u.z / L * radii.z))
        n.normalize()
        v.co += n * HELMET_OFFSET
    for f in new_faces:
        f.material_index = hair_index
        f.smooth = True
    bm.normal_update()
    return len(new_faces)


def head_weight_group(ob) -> str:
    """The bone the head region is weighted to (player: 'head', npc: 'root')."""
    for name in ("head", "root"):
        if ob.vertex_groups.get(name):
            return name
    raise AssertionError(f"{ob.name}: no head/root vertex group")


def ensure_material(ob, name: str, color) -> int:
    mat = bpy.data.materials.get(name)
    if mat is None:
        mat = bpy.data.materials.new(name)
        mat.use_nodes = True
        bsdf = mat.node_tree.nodes.get("Principled BSDF")
        if bsdf is not None:
            bsdf.inputs["Base Color"].default_value = (*color, 1.0)
            bsdf.inputs["Roughness"].default_value = 0.6
            bsdf.inputs["Metallic"].default_value = 0.0
    if mat.name not in [m.name for m in ob.data.materials]:
        ob.data.materials.append(mat)
    return [m.name for m in ob.data.materials].index(mat.name)


def add_icosphere(bm, centre: Vector, r: float, mat_index: int):
    res = bmesh.ops.create_icosphere(bm, subdivisions=1, radius=r)
    verts = res["verts"]
    bmesh.ops.translate(bm, verts=verts, vec=centre)
    faces = {f for v in verts for f in v.link_faces}
    for f in faces:
        f.material_index = mat_index
        f.smooth = True
    return verts


def add_smile(bm, mat_index: int):
    """Half-torus in the XZ-ish plane, arc opening upward, facing -Y."""
    verts_grid = []
    for i in range(MOUTH_SEGS + 1):
        # arc from left to right along the LOWER semicircle (smile)
        a = math.pi + (i / MOUTH_SEGS) * math.pi  # pi..2pi
        ring_c = Vector((math.cos(a) * MOUTH_MAJOR, 0.0, math.sin(a) * MOUTH_MAJOR))
        ring = []
        for j in range(MOUTH_RING):
            b = (j / MOUTH_RING) * 2 * math.pi
            # cross-section circle in the plane spanned by radial dir and Y
            radial = Vector((math.cos(a), 0.0, math.sin(a)))
            p = ring_c + radial * (math.cos(b) * MOUTH_MINOR) + Vector((0.0, math.sin(b) * MOUTH_MINOR, 0.0))
            ring.append(bm.verts.new(MOUTH_C + p))
        verts_grid.append(ring)
    new_faces = []
    for i in range(MOUTH_SEGS):
        for j in range(MOUTH_RING):
            a0 = verts_grid[i][j]
            a1 = verts_grid[i][(j + 1) % MOUTH_RING]
            b0 = verts_grid[i + 1][j]
            b1 = verts_grid[i + 1][(j + 1) % MOUTH_RING]
            new_faces.append(bm.faces.new((a0, b0, b1, a1)))
    for f in new_faces:
        f.material_index = mat_index
        f.smooth = True
    bm.normal_update()
    return [v for ring in verts_grid for v in ring]


def weight_new_verts(ob, indices, group_name: str) -> None:
    vg = ob.vertex_groups.get(group_name) or ob.vertex_groups.new(name=group_name)
    vg.add(indices, 1.0, "REPLACE")


def export_glb(path: Path) -> None:
    want = {
        "filepath": str(path),
        "export_format": "GLB",
        "export_yup": True,
        "export_apply": False,
        "export_animations": True,
        "export_animation_mode": "ACTIONS",
        "export_optimize_animation_size": False,
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


def do_player() -> None:
    src = MODELS / "player.glb"
    ensure_preface(src)
    wipe()
    bpy.ops.import_scene.gltf(filepath=str(src), merge_vertices=True)
    body = bpy.data.objects["PlayerBody"]
    outline = bpy.data.objects["PlayerOutline"]

    for ob, c, r in ((body, P_HEAD_C, P_HEAD_R), (outline, P_HEAD_C, P_HEAD_R)):
        z_before = max(v.co.z for v in ob.data.vertices)
        bm = bmesh.new()
        bm.from_mesh(ob.data)
        weld(bm)
        if ob is outline:
            # project the hull's head onto a shell ellipsoid grown by the gap
            grown = Vector((r.x + 0.005, r.y + 0.005, r.z + 0.005))
            moved = round_head(bm, c, grown)
        else:
            moved = round_head(bm, c, r)
        bm.to_mesh(ob.data)
        bm.free()
        ob.data.update()
        z_after = max(v.co.z for v in ob.data.vertices)
        print(f"  {ob.name}: rounded {moved} midpoint verts, maxZ {z_before:.4f}->{z_after:.4f}")
        assert abs(z_after - z_before) < 1e-4, f"{ob.name}: head rounding moved the crown"
        assert moved > 100, f"{ob.name}: only {moved} verts projected — selection failed"

    # Face + hair helmet on the body only.
    eye_i = ensure_material(body, "Eye", (0.024, 0.024, 0.028))
    shine_i = ensure_material(body, "EyeShine", (1.0, 1.0, 1.0))
    hair_i = [m.name for m in body.data.materials].index("Hair")
    bm = bmesh.new()
    bm.from_mesh(body.data)
    start = len(bm.verts)
    helmet_faces = add_hair_helmet(bm, P_HEAD_C, P_HEAD_R, hair_i)
    print(f"  PlayerBody: hair helmet added ({helmet_faces} faces)")
    new = []
    for sx in (-1, 1):
        new += add_icosphere(bm, Vector((sx * EYE_POS[0], EYE_POS[1], EYE_POS[2])), EYE_R, eye_i)
        new += add_icosphere(bm, Vector((sx * SHINE_POS[0], SHINE_POS[1], SHINE_POS[2])), SHINE_R, shine_i)
    new += add_smile(bm, eye_i)
    bm.verts.index_update()
    new_indices = [v.index for v in bm.verts if v.index >= start]
    bm.to_mesh(body.data)
    bm.free()
    body.data.update()
    weight_new_verts(body, new_indices, "head")
    unweighted = [v.index for v in body.data.vertices if not v.groups]
    assert not unweighted, f"face verts left unweighted: {len(unweighted)}"
    print(f"  PlayerBody: face added ({len(new_indices)} verts: 2 eyes + 2 shines + smile)")

    export_glb(src)
    print(f"wrote {src}")


def do_npc() -> None:
    src = MODELS / "npc.glb"
    ensure_preface(src)
    wipe()
    bpy.ops.import_scene.gltf(filepath=str(src), merge_vertices=True)
    npc = bpy.data.objects["Npc"]
    z_before = max(v.co.z for v in npc.data.vertices)
    bm = bmesh.new()
    bm.from_mesh(npc.data)
    weld(bm)
    moved = round_head(bm, N_HEAD_C, N_HEAD_R)
    bm.to_mesh(npc.data)
    bm.free()
    npc.data.update()
    z_after = max(v.co.z for v in npc.data.vertices)
    print(f"  Npc: rounded {moved} midpoint verts, maxZ {z_before:.4f}->{z_after:.4f}")
    assert abs(z_after - z_before) < 1e-4, "Npc: head rounding moved the crown"
    assert moved > 100, f"Npc: only {moved} verts projected"
    export_glb(src)
    print(f"wrote {src}")


if __name__ == "__main__":
    do_player()
    do_npc()
    print("Done. Verify per CLAUDE.md visual protocol: npm run dev (port 5173),")
    print("front close-up of the player (eyes/highlights/smile present, head")
    print("silhouette rounder) and a villager (rounder head, runtime eyes intact).")
