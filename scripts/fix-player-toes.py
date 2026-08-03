"""Turn the player's shoes around so the toes lead the walk (headless Blender).

player.glb is authored with its shoes on backwards. Measured from the live
model's geometry (glTF bind space, model faces +Z):

  Shoe    z -0.090 .. +0.050   <- 0.09 BEHIND the ankle, 0.05 in front
  Pants   z -0.050 .. +0.050   symmetric
  Jacket  z -0.070 .. +0.070   symmetric
  Skin    z -0.230 .. +0.230   symmetric
  Hair    z -0.132 .. +0.192   swept FORWARD (a fringe — intentional)

so the shoes are the only part pointing the wrong way. It went unnoticed for
as long as both avatars were wrong together; once scripts/rig-npc.py turned
the villagers' toes forward, the player was the odd one out and read as
moon-walking.

The fix mirrors the shoe island front-to-back (Blender y == glTF -z after
import) and reverses those faces, since mirroring flips winding. Vertices move
in BIND space only — JOINTS/WEIGHTS, the armature and the Idle/Walk clips are
untouched, so the rig keeps working exactly as before (the same guarantee
fix-avatar-gaps.py relies on).

PlayerOutline is a 1:1 per-part duplicate of the body islands, so its shoe
copy gets the identical treatment or the outline would peel away from the
shoe. It has one material for the whole hull, so its shoes are selected by
POSITION (z < -0.55, the same threshold fix-avatar-gaps.py's classify_player
uses) rather than by material.

Run (Blender 5.1 installed on this machine):
  & "C:\\Program Files\\Blender Foundation\\Blender 5.1\\blender.exe" `
      --background --python scripts/fix-player-toes.py

PIPELINE ORDER: this consumes the gap-fixed player.glb. If fix-avatar-gaps.py
is ever re-run it restores the pristine BACKWARDS-shoe original, so re-run
this afterwards. Idempotent: the pre-flip input is kept in scripts/backup/ and
restored before each run, so re-running never mirrors twice (which would put
the toes back to front).
"""

from pathlib import Path
import shutil

import bpy
import bmesh

REPO = Path(__file__).resolve().parents[1]
MODELS = REPO / "public" / "assets" / "models"
BACKUP = REPO / "scripts" / "backup"

SHOE_MAX_Z = -0.55  # everything below this (Blender z == glTF y) is a shoe


def wipe() -> None:
    bpy.ops.wm.read_factory_settings(use_empty=True)


def ensure_pristine(path: Path) -> None:
    """First run: back up the pre-flip model. Later runs: restore it."""
    BACKUP.mkdir(parents=True, exist_ok=True)
    bak = BACKUP / (path.name + ".pretoes")
    if bak.exists():
        shutil.copy2(bak, path)
    else:
        shutil.copy2(path, bak)


def obj(name: str):
    ob = bpy.data.objects.get(name)
    assert ob is not None and ob.type == "MESH", f"expected mesh object {name!r} after import"
    return ob


def flip_toes(ob, select) -> int:
    """Mirror the selected faces front-to-back about the ankle, keeping normals."""
    bm = bmesh.new()
    bm.from_mesh(ob.data)
    faces = [f for f in bm.faces if select(f, ob)]
    verts = {v for f in faces for v in f.verts}
    for v in verts:
        v.co.y = -v.co.y  # Blender y == glTF -z: this is the depth axis
    if faces:
        bmesh.ops.reverse_faces(bm, faces=faces)
    bm.to_mesh(ob.data)
    bm.free()
    ob.data.update()
    return len(verts)


def shoe_material_index(ob) -> int:
    for i, m in enumerate(ob.data.materials):
        if "shoe" in (m.name or "").lower():
            return i
    raise AssertionError(f"no Shoe material on {ob.name}: {[m.name for m in ob.data.materials]}")


def depth_span(ob, select) -> tuple[float, float]:
    bm = bmesh.new()
    bm.from_mesh(ob.data)
    ys = [v.co.y for f in bm.faces if select(f, ob) for v in f.verts]
    bm.free()
    return (min(ys), max(ys)) if ys else (0.0, 0.0)


def export_glb(path: Path) -> None:
    """Re-export with the skin and both actions intact (matches the source)."""
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


def fix_player() -> None:
    src = MODELS / "player.glb"
    ensure_pristine(src)
    wipe()
    bpy.ops.import_scene.gltf(filepath=str(src), merge_vertices=True)
    body, outline = obj("PlayerBody"), obj("PlayerOutline")
    arm = next(o for o in bpy.data.objects if o.type == "ARMATURE")
    bones = {b.name for b in arm.data.bones}
    assert {"hips", "spine", "head", "armL", "armR", "legL", "legR"} <= bones, bones

    shoe_i = shoe_material_index(body)
    body_shoes = lambda f, _ob: f.material_index == shoe_i
    # The outline is one material, so its shoes are picked out by height.
    outline_shoes = lambda f, _ob: f.calc_center_median().z < SHOE_MAX_Z

    for ob, sel, label in ((body, body_shoes, "body"), (outline, outline_shoes, "outline")):
        before = depth_span(ob, sel)
        moved = flip_toes(ob, sel)
        after = depth_span(ob, sel)
        # Blender y is glTF -z, so a glTF span of -0.09..+0.05 prints here as
        # -0.05..+0.09; either way the sign of the wider end must flip.
        print(f"{label}: {moved} shoe verts, depth {before} -> {after}")
        assert moved > 0, f"no shoe faces matched on {label}"
        assert abs(after[0] + before[1]) < 1e-5, f"{label} shoes were not mirrored"

    export_glb(src)
    print(f"wrote {src}")


if __name__ == "__main__":
    fix_player()
    print("Done. Verify per CLAUDE.md visual protocol: npm run dev (port 5173),")
    print("screenshot the player walking in profile — toes must lead.")
