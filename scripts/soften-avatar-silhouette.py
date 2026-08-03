"""Chamfer the avatars' box parts so the silhouette reads soft, not slab.

"Simple but soft and smooth": the shading pass (smooth-avatar-shading.py)
already makes curved surfaces SHADE smooth, but every garment part is still a
literal box, so the OUTLINE is hard. The cue that matters at gameplay distance
is not visible corner rounding — a ~0.02 chamfer is 2-3 px on a 250 px
character — it is silhouette pumping: a square-section limb's apparent width
throbs by 41% (circumradius/inradius) as it rotates through the Walk cycle.
At the regular-octagon point that drops to 8%. This pass rolls a 1-2 segment
chamfer onto every ~90-degree box edge, width proportional to each part's own
thinnest dimension, which turns every square section into a near-regular
octagon and every box corner into a small fillet.

KNOBS (the intended way to iterate is edit-here + re-run, never edit logic):
  WIDTH_FRAC_THIN / THICK  chamfer width as a fraction of the part's smallest
                           bbox dimension. 0.29 IS the regular-octagon point;
                           thick parts (torso) use 0.18 so the body keeps its
                           blocky identity while limbs go properly rounded.
  PROFILE = 0.50           circular fillet. MUST stay <= 0.50: at 0.62+ the
                           chamfer's own dihedrals exceed the 60-degree
                           smooth threshold and the fillet shades FACETED
                           (measured: profile 0.62 -> 62.3 deg on 208 edges).
                           A plumper roll needs the threshold raised in BOTH
                           this script and smooth-avatar-shading.py.
  segments                 2 on the player (hero, close camera), 1 on the npc
                           (x21 on screen; a single 45-degree chamfer already
                           kills the pumping and halves the added tris).

Box DETECTION is topological, not name-based: after welding and dissolving
the glTF triangulation diagonals, a box is a loose part with exactly 8 verts,
every edge manifold, and exactly 12 edges of dihedral >= BOX_ANGLE_DEG. The
head (icosphere), hair shell and neck cylinder fail the test and are left
untouched — their curvature is already handled by the shading pass.

TWO SILENT-NO-OP TRAPS this script asserts against (both measured):
  - Without the 1e-5 weld the import is per-face islands and bevel has no
    manifold edges to work on — it exports an unchanged model with exit 0.
  - Without dissolve_limit first, the coplanar triangulation diagonals get
    dragged into the bevel corners and come out at 60.6-69.9 deg — above the
    smooth threshold, so the new fillets render with visible creases.
    delimit={'MATERIAL'} keeps the dissolve from ever merging across a
    Shoe/Pants/Jacket seam.

OUTLINE: the inverted-hull PlayerOutline is beveled IN PLACE with the same
box detector (it is a 1:1 box-part duplicate, so per-part widths derived from
its own dims track the body's chamfers within ~0.0005), then every hull vert
is pushed OUT by OUTLINE_INFLATE to restore the clearance the chamfer eats at
corners (measured: beveling both meshes drops the min body-hull gap from
0.00115 to ~0.0003 — z-fight territory). "Out" on this mesh means AGAINST the
vertex normal: the authored hull has reversed faces, so its normals point
inward. Nothing else about the hull is touched — winding, normals convention,
skinning and materials stay exactly as authored. (A from-scratch rebuild of
the hull from the beveled body was tried first and rendered WRONG in-game —
the shell covered the trunk — despite importing back into Blender with
winding, matrices, bind matrices and inverse-bind matrices all identical to
the authored file. Whatever convention the authored asset carries that the
round-trip does not surface, the lesson stands: never re-author the hull,
only transform it.)

Run (Blender 5.1 installed on this machine):
  & "C:\\Program Files\\Blender Foundation\\Blender 5.1\\blender.exe" `
      --background --python scripts/soften-avatar-silhouette.py

PIPELINE ORDER (new slot 4 of 5):
  fix-avatar-gaps -> fix-player-toes -> rig-npc -> THIS -> smooth-avatar-shading
Idempotent the fix-avatar-gaps way: bevel COMPOUNDS, so each run restores
scripts/backup/*.presoften first (taken from rig-npc's output). If anything
upstream changes, delete the .presoften snapshots together with the other
downstream snapshots and re-run the FULL chain from the top — see the
PIPELINE HAZARD note in fix-avatar-gaps.py.
"""

from pathlib import Path
import math
import shutil

import bpy
import bmesh

REPO = Path(__file__).resolve().parents[1]
MODELS = REPO / "public" / "assets" / "models"
BACKUP = REPO / "scripts" / "backup"

# ----------------------------------------------------------------- knobs
WIDTH_FRAC_THIN = 0.29   # parts thinner than THICK_MIN_DIM (limbs, shoes)
WIDTH_FRAC_THICK = 0.18  # chunky parts (torso) keep more of their mass
THICK_MIN_DIM = 0.12
PROFILE = 0.50           # circular fillet; see docstring before raising
SMOOTH_ANGLE_DEG = 60.0  # MUST match smooth-avatar-shading.py
BOX_ANGLE_DEG = 85.0     # dihedral that marks an authored box edge
WELD_DIST = 1e-5
DISSOLVE_DEG = 0.5       # limited-dissolve angle for triangulation diagonals
OUTLINE_INFLATE = 0.002  # push the beveled hull out to restore corner clearance
FOOT_Z = -0.6716         # outline may not dip below the authored hull floor

TARGETS = {
    # file: (segments, expected box count, outline object or None)
    "player.glb": {"segments": 2, "expect_boxes": 10, "outline": "PlayerOutline", "body": "PlayerBody"},
    "npc.glb": {"segments": 1, "expect_boxes": 7, "outline": None, "body": "Npc"},
}


def wipe() -> None:
    bpy.ops.wm.read_factory_settings(use_empty=True)


def ensure_presoften(path: Path) -> None:
    """Bevel compounds, so restore the pre-soften snapshot before every run."""
    BACKUP.mkdir(parents=True, exist_ok=True)
    bak = BACKUP / (path.name + ".presoften")
    if bak.exists():
        shutil.copy2(bak, path)
    else:
        shutil.copy2(path, bak)


def loose_parts(bm):
    """Connected components as lists of faces."""
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
    return parts


def part_verts(faces):
    return {v for f in faces for v in f.verts}


def is_box(faces, box_rad: float) -> bool:
    verts = part_verts(faces)
    if len(verts) != 8:
        return False
    edges = {e for f in faces for e in f.edges}
    hard = 0
    for e in edges:
        if len(e.link_faces) != 2:
            return False  # open or non-manifold: not a closed box
        if e.calc_face_angle() >= box_rad:
            hard += 1
    return hard == 12


def soften_mesh(ob, segments: int) -> dict:
    """Weld -> dissolve diagonals -> chamfer every box -> re-derive shading."""
    me = ob.data
    bm = bmesh.new()
    bm.from_mesh(me)
    verts_in = len(bm.verts)
    tris_in = sum(len(f.verts) - 2 for f in bm.faces)

    bmesh.ops.remove_doubles(bm, verts=bm.verts[:], dist=WELD_DIST)
    bm.normal_update()

    # Coplanar triangulation diagonals must go BEFORE beveling (see docstring).
    bmesh.ops.dissolve_limit(
        bm,
        angle_limit=math.radians(DISSOLVE_DEG),
        verts=bm.verts[:],
        edges=bm.edges[:],
        delimit={"MATERIAL"},
    )
    bm.normal_update()
    bm.faces.index_update()
    bm.edges.index_update()

    box_rad = math.radians(BOX_ANGLE_DEG)
    boxes = [p for p in loose_parts(bm) if is_box(p, box_rad)]

    beveled = []
    for faces in boxes:
        verts = part_verts(faces)
        lo = [min(v.co[i] for v in verts) for i in range(3)]
        hi = [max(v.co[i] for v in verts) for i in range(3)]
        mn = min(h - l for h, l in zip(hi, lo))
        frac = WIDTH_FRAC_THICK if mn >= THICK_MIN_DIM else WIDTH_FRAC_THIN
        width = mn * frac
        edges = [
            e
            for e in {e for f in faces for e in f.edges}
            if len(e.link_faces) == 2 and e.calc_face_angle() >= box_rad
        ]
        bmesh.ops.bevel(
            bm,
            geom=edges,
            offset=width,
            offset_type="OFFSET",
            segments=segments,
            profile=PROFILE,
            affect="EDGES",
            clamp_overlap=True,
            loop_slide=True,
            # -1 = inherit from the nearest existing face. The operator's
            # DEFAULT is 0, which silently dumps every chamfer face into
            # material slot 0 (= Shoe on both avatars) — measured: 984 of the
            # player's 1208 tris ended up shoe-coloured, torso included.
            material=-1,
        )
        bm.normal_update()
        beveled.append(round(width, 4))

    # Every part is single-material by construction, and material=-1 must keep
    # it that way — a mixed part means bevel faces were dumped into the wrong
    # slot and the avatar renders in the wrong colours.
    for faces in loose_parts(bm):
        mats = {f.material_index for f in faces}
        assert len(mats) == 1, (
            f"{ob.name}: a part carries material indices {sorted(mats)} after bevel — "
            "chamfer faces landed in the wrong material slot"
        )

    # Same shading semantics as smooth-avatar-shading.py, in the same pass, so
    # the new fillets shade smooth immediately and the downstream pass is a
    # confirming no-op rather than a required fixup.
    smooth_rad = math.radians(SMOOTH_ANGLE_DEG)
    for f in bm.faces:
        f.smooth = True
    for e in bm.edges:
        e.smooth = len(e.link_faces) == 2 and e.link_faces[0].normal.angle(e.link_faces[1].normal) <= smooth_rad

    verts_out = len(bm.verts)
    tris_out = sum(len(f.verts) - 2 for f in bm.faces)
    bm.to_mesh(me)
    bm.free()
    me.update()
    return {
        "verts": (verts_in, verts_out),
        "tris": (tris_in, tris_out),
        "boxes": len(boxes),
        "widths": beveled,
    }


def inflate_outline(outline):
    """Push the beveled hull outward to restore body-hull clearance.

    The authored hull has reversed faces, so its vertex normals point INWARD
    — outward is minus-normal. The foot plane is clamped so the hull never
    dips below its authored floor.
    """
    bm = bmesh.new()
    bm.from_mesh(outline.data)
    bm.normal_update()
    for v in bm.verts:
        v.co -= v.normal * OUTLINE_INFLATE
        if v.co.z < FOOT_Z:
            v.co.z = FOOT_Z
    bm.to_mesh(outline.data)
    bm.free()
    outline.data.update()


def export_glb(path: Path) -> None:
    """Identical flag set to the rest of the pipeline."""
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


def soften(name: str, cfg: dict) -> None:
    src = MODELS / name
    assert src.exists(), f"missing {src}"
    ensure_presoften(src)

    wipe()
    bpy.ops.import_scene.gltf(filepath=str(src), merge_vertices=True)

    body = bpy.data.objects.get(cfg["body"])
    assert body is not None and body.type == "MESH", f"no {cfg['body']} in {name}"
    outline = bpy.data.objects.get(cfg["outline"]) if cfg["outline"] else None
    if cfg["outline"]:
        assert outline is not None, f"no {cfg['outline']} in {name}"

    foot_before = min(v.co.z for v in body.data.vertices)

    r = soften_mesh(body, cfg["segments"])
    print(
        f"  {name} :: {body.name:<14} verts {r['verts'][0]}->{r['verts'][1]} "
        f"tris {r['tris'][0]}->{r['tris'][1]} boxes={r['boxes']} widths={r['widths']}"
    )
    assert r["boxes"] == cfg["expect_boxes"], (
        f"{body.name}: found {r['boxes']} boxes, expected {cfg['expect_boxes']} — "
        "geometry moved upstream; re-measure before beveling"
    )
    assert r["tris"][1] > r["tris"][0], f"{body.name}: bevel added no geometry (silent no-op)"

    # The chamfer must never move the ground contact: bevel is edge-inset,
    # clamped, so the sole plane keeps its authored z.
    foot_after = min(v.co.z for v in body.data.vertices)
    assert abs(foot_after - foot_before) < 1e-4, (
        f"{body.name}: foot level moved {foot_before:.4f} -> {foot_after:.4f}"
    )

    if body.vertex_groups:
        unweighted = [v.index for v in body.data.vertices if not v.groups]
        assert not unweighted, f"{body.name}: {len(unweighted)} verts unweighted after bevel"

    if outline is not None:
        ro = soften_mesh(outline, cfg["segments"])
        print(
            f"  {name} :: {outline.name:<14} verts {ro['verts'][0]}->{ro['verts'][1]} "
            f"tris {ro['tris'][0]}->{ro['tris'][1]} boxes={ro['boxes']} (+{OUTLINE_INFLATE} inflate)"
        )
        # The hull is a 1:1 box-part duplicate of the body: same boxes, or the
        # ink line no longer matches the silhouette it outlines.
        assert ro["boxes"] == cfg["expect_boxes"], (
            f"{outline.name}: {ro['boxes']} boxes vs body's {cfg['expect_boxes']}"
        )
        inflate_outline(outline)

    armatures = [o for o in bpy.context.scene.objects if o.type == "ARMATURE"]
    assert armatures, f"{name}: armature lost"
    export_glb(src)
    print(f"wrote {src}")


if __name__ == "__main__":
    for target, cfg in TARGETS.items():
        soften(target, cfg)
    print("Done. Verify per CLAUDE.md visual protocol: npm run dev (port 5173),")
    print("screenshot the player and a villager — limb silhouettes must read")
    print("rounded (octagonal) while the sole, hem and hairline stay crisp.")
