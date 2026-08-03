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

# SOFTEN V2 (researched + measured by the judge workflow): thicken the limbs
# in X/Y only — the chamfer width derives from min-dim, so a thicker limb
# automatically earns a proportionally bigger fillet, and the on-screen
# chamfer goes ~2.6px -> ~4px on a 250px character. Z is NEVER scaled: foot
# level and every height anchor stay bit-exact. Rules per (material, side):
# factor = X/Y scale about the part's own centre; clamp = min |x| the part's
# inner face must keep (translate outward if breached); sole = keep the
# shoe's bottom-face edges sharp (flat grounded sole, 70/30 rule); scale3d =
# uniform scale (the player's mitten hands: 25% of head height per the
# mascot oversized-extremity rule).
THICKEN = {
    "player.glb": [
        {"mat": "Jacket", "side": True, "factor": 1.55},
        {"mat": "Pants", "factor": 1.35, "clamp": 0.050},
        {"mat": "Shoe", "factor": 1.30, "clamp": 0.040, "sole": True},
        {"mat": "Skin", "side": True, "scale3d": 2.0},
    ],
    "npc.glb": [
        {"mat": "Shirt", "side": True, "factor": 1.50},
        {"mat": "Pants", "factor": 1.65, "clamp": 0.0175},
        {"mat": "Shoe", "factor": 1.55, "clamp": 0.0125, "sole": True},
    ],
}
SIDE_X = 0.10  # |part centre x| beyond which a part counts as a side part

# The villagers have NO hands — sleeves end in mid-air. Two cuboids on the
# existing Skin slot (dressNpc recolours by lowercased includes('skin'), so
# the slot must be reused, never renamed), weighted rigidly to the arm bones.
NPC_HANDS = {
    "size": (0.107, 0.120, 0.100),
    "at": (0.170, 0.0, 0.735),
    "bones": ("armL", "armR"),
}

TARGETS = {
    # file: (segments, expected box count, outline object or None)
    "player.glb": {"segments": 2, "expect_boxes": 10, "outline": "PlayerOutline", "body": "PlayerBody"},
    # npc seg=2: dressNpc swaps villagers to MeshToonMaterial with a 12-step
    # NearestFilter ramp; at seg=1 the chamfer's whole 90-degree normal sweep
    # sits in one ~1px facet and the ramp aliases it into shimmer. (The raw
    # GLB is MeshStandardMaterial and will not show this — trust the ramp.)
    # expect_boxes 9 = 7 garment boxes + the 2 new hands.
    "npc.glb": {"segments": 2, "expect_boxes": 9, "outline": None, "body": "Npc"},
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


def part_rule(rules, mat_name, centre):
    """The THICKEN rule matching a part, by material and side-ness."""
    for r in rules:
        if r["mat"] != mat_name:
            continue
        if r.get("side") and abs(centre.x if hasattr(centre, "x") else centre[0]) <= SIDE_X:
            continue
        return r
    return None


def soften_mesh(ob, segments: int, rules=None, body_parts=None) -> dict:
    """Weld -> dissolve -> thicken -> chamfer every box -> re-derive shading.

    rules: THICKEN entries for this model (or None).
    body_parts: for the single-material outline hull, the body's measured
    [(centre, mat_name)] list — each hull part inherits the rule of the
    nearest body part, since the hull is a 1:1 positional duplicate.
    Returns the body's own part list in the report for exactly that reuse.
    """
    me = ob.data
    mats = [m.name for m in me.materials]
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

    def centre_of(faces):
        vs = part_verts(faces)
        lo = [min(v.co[i] for v in vs) for i in range(3)]
        hi = [max(v.co[i] for v in vs) for i in range(3)]
        return [(l + h) / 2 for l, h in zip(lo, hi)]

    def mat_of(faces, centre):
        if body_parts is not None:
            # hull: single Outline slot — inherit from the nearest body part
            best = min(body_parts, key=lambda bp: sum((a - b) ** 2 for a, b in zip(bp[0], centre)))
            return best[1]
        return mats[faces[0].material_index]

    # ---- V2 thicken pass (before box detection: scaling keeps boxes boxes)
    part_records = []
    thickened = []
    if rules:
        for faces in loose_parts(bm):
            centre = centre_of(faces)
            mname = mat_of(faces, centre)
            part_records.append((centre, mname))
            rule = part_rule(rules, mname, type("C", (), {"x": centre[0]})())
            if rule is None:
                continue
            vs = part_verts(faces)
            if "scale3d" in rule:
                s = rule["scale3d"]
                for v in vs:
                    for i in range(3):
                        v.co[i] = centre[i] + (v.co[i] - centre[i]) * s
                thickened.append(f"{mname}@{centre[0]:+.2f} x{s} (3d)")
            else:
                s = rule["factor"]
                for v in vs:
                    v.co.x = centre[0] + (v.co.x - centre[0]) * s
                    v.co.y = centre[1] + (v.co.y - centre[1]) * s
                # clamp: the inner face must keep clearance from the midline
                clamp = rule.get("clamp")
                if clamp is not None and abs(centre[0]) > 1e-4:
                    inner = min(abs(v.co.x) for v in vs)
                    if inner < clamp:
                        shift = (clamp - inner) * (1 if centre[0] > 0 else -1)
                        for v in vs:
                            v.co.x += shift
                thickened.append(f"{mname}@{centre[0]:+.2f} x{s}")
        bm.normal_update()
    else:
        for faces in loose_parts(bm):
            part_records.append((centre_of(faces), mats[faces[0].material_index]))

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
        centre = [(l + h) / 2 for l, h in zip(lo, hi)]
        rule = part_rule(rules or [], mat_of(faces, centre), type("C", (), {"x": centre[0]})())
        sole_z = lo[2] if (rule and rule.get("sole")) else None
        edges = [
            e
            for e in {e for f in faces for e in f.edges}
            if len(e.link_faces) == 2 and e.calc_face_angle() >= box_rad
            # keep the shoe's grounded sole a crisp flat: skip edges lying
            # entirely in the bottom plane
            and not (sole_z is not None and all(abs(v.co.z - sole_z) < 1e-6 for v in e.verts))
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
        midx = {f.material_index for f in faces}
        assert len(midx) == 1, (
            f"{ob.name}: a part carries material indices {sorted(midx)} after bevel — "
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
        "parts": part_records,
        "thickened": thickened,
    }


def add_npc_hands(ob) -> int:
    """Give a villager mitten hands: two chamfer-ready cuboids on the Skin
    slot, rigidly weighted to the arm bones. Runs BEFORE soften_mesh so the
    box detector picks them up and they get the same rounded treatment."""
    mats = [m.name for m in ob.data.materials]
    skin_i = next(i for i, m in enumerate(mats) if "skin" in m.lower())
    sx, sy, sz = NPC_HANDS["size"]
    ax, ay, az = NPC_HANDS["at"]

    bm = bmesh.new()
    bm.from_mesh(ob.data)
    deform = bm.verts.layers.deform.verify()
    added = 0
    for sign, bone in ((-1, NPC_HANDS["bones"][0]), (1, NPC_HANDS["bones"][1])):
        vg = ob.vertex_groups.get(bone)
        assert vg is not None, f"{ob.name}: no vertex group {bone} — is the npc rigged yet?"
        res = bmesh.ops.create_cube(bm, size=1.0)
        verts = res["verts"]
        for v in verts:
            v.co.x = v.co.x * sx + sign * ax
            v.co.y = v.co.y * sy + ay
            v.co.z = v.co.z * sz + az
            v[deform][vg.index] = 1.0
        for f in {f for v in verts for f in v.link_faces}:
            f.material_index = skin_i
        added += len(verts)
    bm.to_mesh(ob.data)
    bm.free()
    ob.data.update()
    return added


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

    if name == "npc.glb":
        added = add_npc_hands(body)
        print(f"  {name} :: hands added ({added} verts, Skin slot, armL/armR)")

    rules = THICKEN.get(name)
    r = soften_mesh(body, cfg["segments"], rules=rules)
    print(
        f"  {name} :: {body.name:<14} verts {r['verts'][0]}->{r['verts'][1]} "
        f"tris {r['tris'][0]}->{r['tris'][1]} boxes={r['boxes']} widths={r['widths']}"
    )
    if r["thickened"]:
        print(f"  {name} :: thickened {r['thickened']}")
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
        ro = soften_mesh(outline, cfg["segments"], rules=rules, body_parts=r["parts"])
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
