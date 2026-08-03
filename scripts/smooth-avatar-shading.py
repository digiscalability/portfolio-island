"""Smooth the avatars' curved surfaces without softening their hard edges.

Both avatars ship FLAT-SHADED: every face carries its own split vertices, so
the heads read as faceted polyhedra rather than low-poly-but-round. Measured
from the live models (unique-position vs vertex count — a fully flat mesh
splits to 3.0 for a triangle soup, higher where verts are shared by more):

  player Skin    336 verts / 106 unique   split 3.17    132 tris
  player Hair     60 verts /  12 unique   split 5.00     20 tris  (100% split)
  player Jacket   96 verts /  32 unique   split 3.00     48 tris
  npc    head    240 verts /  42 unique   split 5.71     80 tris  (100% split)

The faceting is geometry, NOT the toon ramp: the player's body meshes are
MeshStandardMaterial with no gradientMap at all, so there are no bands to
blame. (An earlier pass mis-measured `SimplePlayer.mesh` — a DETACHED leftover
group that is never rendered — and concluded the opposite. The avatar actually
on screen is the GLB scene parented under the SimplePlayer group.)

The angle distribution says the two cases separate cleanly, so one threshold
does the whole job:

  Shoe / Pants / Jacket   every shared-vertex pair is EXACTLY 90 deg (boxes)
  Skin                    median 35.7, p90 41.8, with some real 90 deg edges
  Hair                    median 49.3, p90 86.3 (chunky by design)

At 60 deg the heads round out while every 90 deg box corner and the authored
hard edges stay crisp. Verified in-browser before writing this script by
averaging normals live: 40 deg was too tight to change the head at all, 60 deg
matched an unconditional weld on the head and left the torso untouched.

WHY NOT shade_auto_smooth(): in Blender 4.1+ that operator adds a "Smooth by
Angle" geometry-nodes modifier, and this pipeline exports with
export_apply=False (applying modifiers is what would endanger the rig). The
modifier would never reach the .glb. Instead this bakes the same semantics
into real mesh data — every face smooth, edges above the threshold marked
sharp — which the glTF exporter turns into split normals on its own.

Vertices are never MOVED, but they are WELDED, and that part is load-bearing:
a flat-shaded glTF stores one vertex per face-corner, so an unwelded import is
a soup of disconnected faces with no edge carrying two faces to compare —
nothing can be smoothed. The 1e-5 remove_doubles below fixes that. Exact
before/after counts depend on which upstream passes already ran:
fix-avatar-gaps.py now welds too, so by the time this script runs the weld
here is usually a near-no-op (kept because this script must also work
standalone on an unwelded model).

NOTE the importer's `merge_vertices=True` does NOT weld these models on
Blender 5.1 — it is topologically inert here because it "cannot combine verts
with different normals" and the flat-shaded avatars split normals at every
corner. Hence the explicit bmesh remove_doubles. (Full measurements live in
fix-avatar-gaps.py's docstring, the pipeline's single source of truth on
this.)

Welding merges only vertices that already share a position, so JOINTS/WEIGHTS
survive: co-located verts were split for normals, not for skinning. The script
asserts every surviving vertex still carries vertex groups, and leaves the
armature and animation clips untouched.

Run (Blender 5.1 installed on this machine):
  & "C:\\Program Files\\Blender Foundation\\Blender 5.1\\blender.exe" `
      --background --python scripts/smooth-avatar-shading.py

PIPELINE ORDER: consumes whatever player.glb / npc.glb currently are, so run
it LAST — after fix-avatar-gaps.py, fix-player-toes.py and rig-npc.py, each of
which restores its own pristine backup and would drop this shading. Unlike
those, this pass is deterministic: the flags it writes depend only on the
threshold, so re-running never compounds. The backup is taken once for revert
and is deliberately NOT restored on later runs (that would undo whichever
pipeline step ran most recently).
"""

from pathlib import Path
import math
import shutil

import bpy
import bmesh

REPO = Path(__file__).resolve().parents[1]
MODELS = REPO / "public" / "assets" / "models"
BACKUP = REPO / "scripts" / "backup"

# Below the 90 deg of a box corner, above the ~42 deg p90 of the head's curvature.
SMOOTH_ANGLE_DEG = 60.0

TARGETS = ("player.glb", "npc.glb")


def wipe() -> None:
    bpy.ops.wm.read_factory_settings(use_empty=True)


def back_up_once(path: Path) -> None:
    """Keep a pre-shading copy for revert. Never restores — see PIPELINE ORDER."""
    BACKUP.mkdir(parents=True, exist_ok=True)
    bak = BACKUP / (path.name + ".preshade")
    if not bak.exists():
        shutil.copy2(path, bak)
        print(f"  backed up {path.name} -> {bak.name}")


def weld_and_smooth(ob, threshold_rad: float) -> dict:
    """Weld co-located verts, then smooth every face and re-sharpen hard edges.

    Returns per-mesh counts so the run can assert it actually did something.
    """
    bm = bmesh.new()
    bm.from_mesh(ob.data)

    verts_before = len(bm.verts)
    bmesh.ops.remove_doubles(bm, verts=bm.verts[:], dist=1e-5)
    bm.normal_update()

    for f in bm.faces:
        f.smooth = True

    sharp = smooth = boundary = 0
    for e in bm.edges:
        if len(e.link_faces) == 2:
            angle = e.link_faces[0].normal.angle(e.link_faces[1].normal)
            keep_smooth = angle <= threshold_rad
            e.smooth = keep_smooth
            if keep_smooth:
                smooth += 1
            else:
                sharp += 1
        else:
            # Open/non-manifold edge: nothing to average across, leave it hard.
            e.smooth = False
            boundary += 1

    verts_after = len(bm.verts)
    bm.to_mesh(ob.data)
    bm.free()
    ob.data.update()

    # Welding must not have stripped skinning off any surviving vertex.
    unweighted = sum(1 for v in ob.data.vertices if not v.groups)
    return {
        "verts_before": verts_before,
        "verts_after": verts_after,
        "smooth": smooth,
        "sharp": sharp,
        "boundary": boundary,
        "unweighted": unweighted,
    }


def export_glb(path: Path) -> None:
    """Re-export with the skin and every action intact (matches the source)."""
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


def shade(name: str) -> None:
    src = MODELS / name
    assert src.exists(), f"missing {src}"
    back_up_once(src)

    wipe()
    bpy.ops.import_scene.gltf(filepath=str(src), merge_vertices=True)

    # scene.objects, NOT bpy.data.objects: both GLBs carry a stray material-less
    # Icosphere that three.js never renders. Iterating bpy.data would also pick
    # up unlinked datablocks and let a no-op run pass the asserts below.
    scene_meshes = [o for o in bpy.context.scene.objects if o.type == "MESH"]
    meshes = [o for o in scene_meshes if o.data.materials]
    skipped = [o.name for o in scene_meshes if not o.data.materials]
    assert meshes, f"no shadeable meshes imported from {name}"
    if skipped:
        print(f"  skipped (no material slots): {skipped}")

    armatures = [o for o in bpy.context.scene.objects if o.type == "ARMATURE"]
    bones_before = {a.name: len(a.data.bones) for a in armatures}
    actions_before = sorted(a.name for a in bpy.data.actions)

    threshold = math.radians(SMOOTH_ANGLE_DEG)
    total_smooth = total_sharp = total_unweighted = 0
    for ob in meshes:
        c = weld_and_smooth(ob, threshold)
        total_smooth += c["smooth"]
        total_sharp += c["sharp"]
        total_unweighted += c["unweighted"]
        print(
            f"  {name} :: {ob.name:<16} verts {c['verts_before']:>4}->{c['verts_after']:<4} "
            f"smooth={c['smooth']:>4} sharp={c['sharp']:>4} "
            f"boundary={c['boundary']:>3} unweighted={c['unweighted']}"
        )

    # Curved surfaces must have smoothed, and the box-shaped garments (whose
    # every shared-vertex pair sits at exactly 90 deg) must have stayed sharp.
    # A run that produced neither means the weld failed and the export would
    # quietly ship an unchanged model — which is exactly how the first version
    # of this script slipped through.
    assert total_smooth > 0, f"{name}: no edge fell under {SMOOTH_ANGLE_DEG} deg"
    assert total_sharp > 0, f"{name}: nothing stayed sharp — threshold too loose?"
    assert total_unweighted == 0, f"{name}: {total_unweighted} verts lost their skinning"

    export_glb(src)

    # The rig is the thing most at risk from an import/export round trip.
    assert bones_before, f"{name}: expected an armature, found none"
    print(f"  {name}: bones {bones_before}, actions {actions_before}")
    print(f"wrote {src}")


if __name__ == "__main__":
    for target in TARGETS:
        shade(target)
    print("Done. Verify per CLAUDE.md visual protocol: npm run dev (port 5173),")
    print("screenshot the player's head close up — the interior facets must be")
    print("gone while the jacket/pants box corners stay crisp.")
