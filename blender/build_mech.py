"""Knight-frame mech for the surface view: hard-surface armour, articulated on the rig's joints.

Run:  blender --background --factory-startup --python blender/build_mech.py -- public/models [preview_dir]
      blender --background --factory-startup --python blender/build_mech.py -- public/models --lod   (-> mech_lo.glb)

Every part is modelled in THREE.js rig space (x = character left, y = up, z = forward, ~1.8 units tall;
the game scales it by 3.1) and converted to Blender space on the way in (x, -z, y), so the glTF export
lands back in three.js coordinates. Each joint is an object whose origin sits on the joint with no rotation;
the game drives those nodes directly with the Noir sword animation and arm IK.

Armour plates are chamfered, tapered boxes (convex hull of per-edge chamfer points, coplanar faces merged)
with V-groove panel lines cut into their large faces, a micro bevel for edge highlights and a weighted-normal
pass. The inner frame is carbon / gunmetal with chrome pistons. Materials are named mech_* and swapped at
runtime for physical car-paint / chrome / carbon materials. anchor_jet_* empties mark thruster nozzles:
their local -Y axis (three.js) points along the exhaust.
"""
import bpy
import bmesh
import math
import os
import sys
from mathutils import Vector, Matrix, Euler

argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
# --lod: lighter build for crowds (arena enemies): no panel grooves, single-segment bevels, half-res curves
LOD = '--lod' in argv
argv = [a for a in argv if a != '--lod']
OUT = os.path.abspath(argv[0] if argv else 'public/models')
PREVIEW = os.path.abspath(argv[1]) if len(argv) > 1 and argv[1] != '-' else None
os.makedirs(OUT, exist_ok=True)

bpy.ops.wm.read_factory_settings(use_empty=True)
SCENE = bpy.context.scene

# ---------------------------------------------------------------- materials (preview look; swapped in game)
PALETTE = {
    'mech_white': ((0.8, 0.82, 0.85), 0.1, 0.3, None),
    'mech_grey': ((0.32, 0.34, 0.37), 0.35, 0.35, None),
    'mech_blue': ((0.015, 0.06, 0.28), 0.5, 0.3, None),
    'mech_red': ((0.55, 0.025, 0.025), 0.25, 0.32, None),
    'mech_gold': ((0.95, 0.62, 0.18), 1.0, 0.22, None),
    'mech_chrome': ((0.85, 0.86, 0.88), 1.0, 0.1, None),
    'mech_frame': ((0.035, 0.037, 0.042), 0.85, 0.4, None),
    'mech_carbon': ((0.012, 0.013, 0.016), 0.4, 0.35, None),
    'mech_seam': ((0.02, 0.022, 0.026), 0.3, 0.6, None),
    'mech_decal_num': ((0.9, 0.9, 0.9), 0.0, 0.5, None),
    'mech_decal_text': ((0.9, 0.9, 0.9), 0.0, 0.5, None),
    'mech_decal_warn': ((0.9, 0.7, 0.1), 0.0, 0.5, None),
    'mech_decal_caution': ((0.8, 0.2, 0.1), 0.0, 0.5, None),
    'mech_glow': ((0, 0, 0), 0.0, 0.5, ((0.25, 0.9, 1.0), 8.0)),
    'mech_eye': ((0, 0, 0), 0.0, 0.5, ((0.3, 1.0, 0.75), 10.0)),
    'mech_nozzle': ((0, 0, 0), 0.0, 0.5, ((0.4, 0.75, 1.0), 4.0)),
}
MATS = {}


def mat(name):
    if name in MATS:
        return MATS[name]
    base, metal, rough, emit = PALETTE[name]
    m = bpy.data.materials.new(name)
    if m.node_tree is None:
        m.use_nodes = True
    nt = m.node_tree
    bsdf = next((n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED'), None)
    if bsdf is None:
        bsdf = nt.nodes.new('ShaderNodeBsdfPrincipled')
        out = next((n for n in nt.nodes if n.type == 'OUTPUT_MATERIAL'), None) or nt.nodes.new('ShaderNodeOutputMaterial')
        nt.links.new(bsdf.outputs[0], out.inputs[0])
    bsdf.inputs['Base Color'].default_value = (*base, 1)
    bsdf.inputs['Metallic'].default_value = metal
    bsdf.inputs['Roughness'].default_value = rough
    if name in ('mech_white', 'mech_blue', 'mech_red', 'mech_grey'):
        bsdf.inputs['Coat Weight'].default_value = 0.8
        bsdf.inputs['Coat Roughness'].default_value = 0.05
    if emit:
        bsdf.inputs['Emission Color'].default_value = (*emit[0], 1)
        bsdf.inputs['Emission Strength'].default_value = emit[1]
    MATS[name] = m
    return m


# ---------------------------------------------------------------- geometry in rig (three.js) space
def T(v):
    """three.js rig space -> Blender space"""
    return Vector((v[0], -v[2], v[1]))


def rot_m(r):
    return Euler(r, 'ZXY').to_matrix().to_4x4()  # == three.js 'YXZ' (intrinsic Y, X, Z)


def fbox(w, h, d, tx=1.0, tz=1.0, bx=1.0, bz=1.0, sz=0.0, bsz=0.0, c=0.008, cx=None, cy=None, cz=None):
    """Chamfered tapered box. Top face scaled (tx, tz) and shifted sz along z, bottom (bx, bz) shifted bsz.
    cx / cy / cz chamfer the edges running along x / y (vertical) / z."""
    cx = c if cx is None else cx
    cy = c if cy is None else cy
    cz = c if cz is None else cz
    bm = bmesh.new()
    for sy in (-1, 1):
        kx, kz, oz = (tx, tz, sz) if sy > 0 else (bx, bz, bsz)
        hw, hd, hh = w / 2 * kx, d / 2 * kz, h / 2
        ax, ay, az = min(cx, hh * 0.9, hd * 0.9), min(cy, hw * 0.9, hd * 0.9), min(cz, hw * 0.9, hh * 0.9)
        for sx in (-1, 1):
            for s2 in (-1, 1):
                X, Y, Z = sx * hw, sy * hh, s2 * hd + oz
                bm.verts.new((X, Y - sy * az, Z - s2 * ay))
                bm.verts.new((X - sx * az, Y, Z - s2 * ax))
                bm.verts.new((X - sx * ay, Y - sy * ax, Z))
    bm.verts.ensure_lookup_table()
    res = bmesh.ops.convex_hull(bm, input=list(bm.verts))
    junk = list({g for g in res['geom_interior'] + res['geom_unused'] if isinstance(g, bmesh.types.BMVert) and g.is_valid})
    if junk:
        bmesh.ops.delete(bm, geom=junk, context='VERTS')
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-5)
    bmesh.ops.dissolve_limit(bm, angle_limit=math.radians(0.5), verts=list(bm.verts), edges=list(bm.edges))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return bm


def lathe(rings, seg=20):
    """Lathe around +Y. rings = [(y, rx, rz), ...] bottom to top; elliptical sections, capped."""
    if LOD:
        seg = max(8, seg // 2)
    bm = bmesh.new()
    loops = []
    for (y, rx, rz) in rings:
        loops.append([bm.verts.new((math.cos(2 * math.pi * i / seg) * rx, y, math.sin(2 * math.pi * i / seg) * rz)) for i in range(seg)])
    for a, b in zip(loops, loops[1:]):
        for i in range(seg):
            j = (i + 1) % seg
            bm.faces.new((a[i], a[j], b[j], b[i]))
    bm.faces.new(list(reversed(loops[0])))
    bm.faces.new(loops[-1])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return bm


def cyl(r, h, seg=20, axis='y', r2=None):
    bm = lathe([(-h / 2, r, r), (h / 2, r2 if r2 is not None else r, r2 if r2 is not None else r)], seg)
    if axis == 'x':
        bmesh.ops.rotate(bm, verts=bm.verts, matrix=Matrix.Rotation(math.pi / 2, 4, 'Z'))
    elif axis == 'z':
        bmesh.ops.rotate(bm, verts=bm.verts, matrix=Matrix.Rotation(math.pi / 2, 4, 'X'))
    return bm


def sphere(r, seg=20, rings=12, scale=(1, 1, 1)):
    if LOD:
        seg, rings = max(8, seg // 2), max(6, rings // 2)
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=seg, v_segments=rings, radius=r)
    bmesh.ops.scale(bm, vec=Vector(scale), verts=bm.verts)
    return bm


def prism(outline, depth, c=0.0):
    """Extrude a 2D outline (x, y) along z, centred on z = 0; c chamfers the front/back rims."""
    bm = bmesh.new()
    pts = []
    for (x, y) in outline:
        pts.append(bm.verts.new((x, y, -depth / 2)))
        pts.append(bm.verts.new((x, y, depth / 2)))
    if c > 0:
        cx, cy = sum(p[0] for p in outline) / len(outline), sum(p[1] for p in outline) / len(outline)
        for (x, y) in outline:
            dx, dy = x - cx, y - cy
            l = math.hypot(dx, dy) or 1
            for z in (-depth / 2 - c, depth / 2 + c):
                bm.verts.new((x - dx / l * c, y - dy / l * c, z))
    res = bmesh.ops.convex_hull(bm, input=list(bm.verts))
    junk = list({g for g in res['geom_interior'] + res['geom_unused'] if isinstance(g, bmesh.types.BMVert) and g.is_valid})
    if junk:
        bmesh.ops.delete(bm, geom=junk, context='VERTS')
    bmesh.ops.dissolve_limit(bm, angle_limit=math.radians(0.5), verts=list(bm.verts), edges=list(bm.edges))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return bm


def groove(bm, min_area, margin=0.011, width=0.0035, depth=0.0035):
    """V-groove panel line around every large face, `margin` in from its edges."""
    big = [f for f in bm.faces if f.calc_area() > min_area and len(f.verts) >= 4]
    if not big:
        return []
    bmesh.ops.inset_individual(bm, faces=big, thickness=margin, depth=0, use_even_offset=True)
    a = bmesh.ops.inset_individual(bm, faces=big, thickness=width * 0.5, depth=-depth, use_even_offset=True)
    b = bmesh.ops.inset_individual(bm, faces=big, thickness=width * 0.5, depth=depth, use_even_offset=True)
    return a['faces'] + b['faces']   # the groove walls: painted with the dark seam material


# ---------------------------------------------------------------- parts
JOINT_WORLD = {}
PARTS = {}


class Part:
    def __init__(self, name, parent, local):
        self.name = name
        self.parent = parent
        self.world = (JOINT_WORLD[parent] if parent else Vector((0, 0, 0))) + Vector(local)
        JOINT_WORLD[name] = self.world
        self.pieces = []
        self.mats = []
        self.anchors = []
        PARTS[name] = self

    def add(self, bm, matname, pos=(0, 0, 0), rot=(0, 0, 0), bevel=0.0025, seg=2, panel=0.0, smooth=True, angle=30):
        """bm in the piece's own frame (rig units); pos/rot place it relative to this joint.
        panel > 0 cuts groove lines into faces larger than that area."""
        if LOD:
            panel, seg = 0.0, 1
        seams = groove(bm, panel) if panel else []
        for f in seams:
            f.material_index = 1
        m = Matrix.Translation(Vector(pos)) @ rot_m(rot)
        bmesh.ops.transform(bm, matrix=m, verts=bm.verts)
        for v in bm.verts:
            v.co = T(v.co)
        me = bpy.data.meshes.new('piece')
        bm.to_mesh(me)
        bm.free()
        for p in me.polygons:
            p.use_smooth = smooth
        me.materials.append(mat(matname))
        me.materials.append(mat('mech_seam'))
        ob = bpy.data.objects.new('piece', me)
        SCENE.collection.objects.link(ob)
        if bevel > 0:
            b = ob.modifiers.new('bevel', 'BEVEL')
            b.width = bevel
            b.segments = seg
            b.limit_method = 'ANGLE'
            b.angle_limit = math.radians(angle)
            b.harden_normals = True
            b.use_clamp_overlap = True
        if smooth:
            wn = ob.modifiers.new('wn', 'WEIGHTED_NORMAL')
            wn.keep_sharp = True
            wn.weight = 100
        dg = bpy.context.evaluated_depsgraph_get()
        me2 = bpy.data.meshes.new_from_object(ob.evaluated_get(dg), preserve_all_data_layers=True, depsgraph=dg)
        if not smooth:
            for p in me2.polygons:
                p.use_smooth = False
        for name in (matname, 'mech_seam'):
            if name not in self.mats:
                self.mats.append(name)
        remap = [self.mats.index(matname), self.mats.index('mech_seam')]
        for p in me2.polygons:
            p.material_index = remap[min(p.material_index, 1)]
        self.pieces.append(me2)
        bpy.data.objects.remove(ob)
        bpy.data.meshes.remove(me)
        return self

    def decal(self, kind, plate_pos, plate_rot, c, n, u, w, h):
        """Textured quad lying on a plate face: c / n / u in the plate's frame (u = text right, v = n x u = up)."""
        n, u = Vector(n).normalized(), Vector(u).normalized()
        v = n.cross(u)
        c = Vector(c) + n * 0.0012
        bm = bmesh.new()
        vs = [bm.verts.new(c + u * (sx * w / 2) + v * (sy * h / 2)) for sx, sy in ((-1, -1), (1, -1), (1, 1), (-1, 1))]
        f = bm.faces.new(vs)
        uv = bm.loops.layers.uv.new('UVMap')
        for l, t in zip(f.loops, ((0, 0), (1, 0), (1, 1), (0, 1))):
            l[uv].uv = t
        return self.add(bm, 'mech_decal_' + kind, plate_pos, plate_rot, bevel=0, smooth=False)

    def anchor(self, name, pos, exhaust):
        self.anchors.append((name, Vector(pos), Vector(exhaust).normalized() if exhaust is not None else None))

    def nozzle(self, pos, exhaust, r=0.03, length=0.05, name=None, ribs=True):
        """Thruster bell at pos (joint-relative) opening along `exhaust`, with a glowing throat."""
        d = Vector(exhaust).normalized()
        q = Vector((0, -1, 0)).rotation_difference(d).to_matrix().to_4x4()
        place = Matrix.Translation(Vector(pos)) @ q
        bell = lathe([(-length, r, r), (-length * 0.7, r * 0.86, r * 0.86), (-length * 0.25, r * 0.62, r * 0.62), (0, r * 0.5, r * 0.5),
                      (0.004, r * 0.56, r * 0.56)], 24)
        # hollow it: inset the exit cap and push it up the bell
        cap = min(bell.faces, key=lambda f: f.calc_center_median().y)
        bmesh.ops.inset_region(bell, faces=[cap], thickness=r * 0.1, depth=-length * 0.8)
        bmesh.ops.transform(bell, matrix=place, verts=bell.verts)
        self.add(bell, 'mech_frame', bevel=0.0015, seg=1)
        ring = lathe([(-length * 0.1, r * 1.04, r * 1.04), (length * 0.12, r * 0.95, r * 0.95)], 24)
        bmesh.ops.transform(ring, matrix=Matrix.Translation(Vector(pos) + d * (length * 0.85)) @ q, verts=ring.verts)
        self.add(ring, 'mech_chrome', bevel=0.0015, seg=1)
        core = cyl(r * 0.6, 0.004, 20)
        bmesh.ops.transform(core, matrix=Matrix.Translation(Vector(pos) + d * (length * 0.18)) @ q, verts=core.verts)
        self.add(core, 'mech_nozzle', bevel=0, smooth=False)
        if name:
            self.anchor(name, Vector(pos) + d * length, d)

    def piston(self, a, b, r=0.009):
        """Hydraulic: gunmetal sleeve from a, chrome rod to b."""
        a, b = Vector(a), Vector(b)
        dvec = b - a
        q = Vector((0, 1, 0)).rotation_difference(dvec.normalized()).to_matrix().to_4x4()
        L = dvec.length
        sleeve = cyl(r * 1.6, L * 0.55, 12)
        bmesh.ops.transform(sleeve, matrix=Matrix.Translation(a + dvec * 0.275) @ q, verts=sleeve.verts)
        self.add(sleeve, 'mech_frame', bevel=0.0015, seg=1)
        rod = cyl(r, L * 0.55, 12)
        bmesh.ops.transform(rod, matrix=Matrix.Translation(a + dvec * 0.725) @ q, verts=rod.verts)
        self.add(rod, 'mech_chrome', bevel=0, seg=1)


def build():
    HIP = 1.06
    P = Part
    hips = P('hips', None, (0, HIP, 0))
    spine = P('spine', 'hips', (0, 0.1, 0))
    chest = P('chest', 'spine', (0, 0.18, 0))
    neck = P('neck', 'chest', (0, 0.24, -0.01))
    head = P('head', 'neck', (0, 0.05, 0.01))
    UA, FA, TH, SH, SW = 0.31, 0.29, 0.46, 0.45, 0.25
    arms, legs = {}, {}
    for s, sx in (('L', 1), ('R', -1)):
        sh = P('sh' + s, 'chest', (sx * SW, 0.16, -0.01))
        el = P('el' + s, 'sh' + s, (0, -UA, 0))
        ha = P('ha' + s, 'el' + s, (0, -FA, 0))
        arms[s] = (sh, el, ha)
        th = P('th' + s, 'hips', (sx * 0.12, -0.05, 0))
        kn = P('kn' + s, 'th' + s, (0, -TH, 0))
        an = P('an' + s, 'kn' + s, (0, -SH, 0))
        legs[s] = (th, kn, an)

    W, Gy, B, R, G, C, F, K = 'mech_white', 'mech_grey', 'mech_blue', 'mech_red', 'mech_gold', 'mech_chrome', 'mech_frame', 'mech_carbon'
    SIDES = (('L', 1), ('R', -1))

    # ================= pelvis
    hips.add(fbox(0.22, 0.12, 0.17, bx=0.7, bz=0.8, c=0.02), K, (0, -0.02, 0))
    hips.add(fbox(0.29, 0.05, 0.2, bx=0.96, c=0.01, cy=0.03), B, (0, 0.045, 0), panel=0.004)
    hips.add(fbox(0.18, 0.012, 0.012), G, (0, 0.045, 0.101), bevel=0.001)
    hips.add(fbox(0.095, 0.14, 0.05, bx=0.42, tz=0.9, c=0.008, cy=0.015), W, (0, -0.065, 0.1), (0.12, 0, 0), panel=0.004)
    hips.add(fbox(0.04, 0.04, 0.016, bx=0.35, c=0.004), R, (0, -0.04, 0.132), (0.12, 0, 0))
    hips.add(fbox(0.24, 0.14, 0.03, bx=1.12, c=0.008), W, (0, -0.07, -0.108), (-0.24, 0, 0), panel=0.006)
    hips.add(fbox(0.2, 0.05, 0.02, c=0.006), Gy, (0, -0.02, -0.122), (-0.24, 0, 0))
    for s, sx in SIDES:
        hips.add(fbox(0.13, 0.19, 0.028, bx=1.2, c=0.008, cy=0.02), W, (sx * 0.106, -0.09, 0.104), (0.3, sx * 0.34, sx * 0.08), panel=0.005)
        hips.add(fbox(0.1, 0.03, 0.012, c=0.004), B, (sx * 0.104, -0.025, 0.115), (0.3, sx * 0.34, sx * 0.08))
        hips.add(fbox(0.032, 0.22, 0.19, bz=1.15, c=0.008, cz=0.02), W, (sx * 0.177, -0.075, 0), (0, 0, sx * 0.2), panel=0.006)
        hips.add(fbox(0.014, 0.12, 0.12, c=0.006), Gy, (sx * 0.195, -0.06, 0.0), (0, 0, sx * 0.2))
        hips.add(fbox(0.016, 0.03, 0.06, c=0.004), G, (sx * 0.203, -0.12, 0.03), (0, 0, sx * 0.2))

    # ================= waist / abdomen (exposed frame with armoured ab plates)
    spine.add(lathe([(-0.02, 0.075, 0.062), (0.05, 0.08, 0.065), (0.13, 0.085, 0.07), (0.16, 0.09, 0.072)], 22), K, bevel=0)
    for i, y in enumerate((0.012, 0.055, 0.098)):
        spine.add(fbox(0.12 + i * 0.01, 0.038, 0.04, tz=0.8, c=0.008, cy=0.012), W, (0, y, 0.072 + i * 0.004), (-0.08, 0, 0))
    for s, sx in SIDES:
        spine.piston((sx * 0.07, -0.01, -0.04), (sx * 0.09, 0.15, -0.035))
        spine.add(fbox(0.03, 0.12, 0.1, c=0.008), Gy, (sx * 0.09, 0.07, 0.0), panel=0.003)

    # ================= chest: blue armoured torso, white cockpit hatch, gold intakes, reactor core
    chest.add(fbox(0.3, 0.24, 0.19, bx=0.72, bz=0.85, c=0.02), K, (0, 0.1, 0))
    for s, sx in SIDES:
        # chest halves meet in a forward V ridge; the top-front edge is cut back hard so it doesn't read as a box rim
        chest.add(fbox(0.235, 0.19, 0.26, bx=0.7, bz=0.86, tz=0.8, sz=-0.012, c=0.012, cy=0.045, cx=0.05), B, (sx * 0.11, 0.158, 0.012), (0, sx * 0.1, sx * -0.03), panel=0.006)
        chest.add(fbox(0.012, 0.15, 0.02, tx=0.5, c=0.004), G, (sx * 0.215, 0.15, 0.09), (0, sx * 0.55, sx * -0.03))
    for s, sx in SIDES:
        # pec plates (layered over the torso, angled outward)
        chest.add(fbox(0.15, 0.12, 0.05, bx=0.7, tz=0.85, c=0.008, cy=0.025), B, (sx * 0.085, 0.165, 0.128), (-0.18, sx * 0.3, 0), panel=0.004)
        # intake vents
        chest.add(fbox(0.095, 0.065, 0.03, c=0.006), F, (sx * 0.13, 0.115, 0.13), (0, sx * 0.42, 0))
        for k in range(4):
            chest.add(fbox(0.085, 0.007, 0.022, c=0.002), G, (sx * 0.132, 0.092 + k * 0.016, 0.137), (0.25, sx * 0.42, 0), bevel=0.001, seg=1)
        # collar wings + shoulder bridge
        chest.add(fbox(0.12, 0.085, 0.12, tx=0.55, c=0.01, cy=0.02), W, (sx * 0.125, 0.275, 0.012), (0, 0, sx * -0.42), panel=0.003)
        chest.add(fbox(0.012, 0.06, 0.08), R, (sx * 0.178, 0.265, 0.012), (0, 0, sx * -0.42))
        chest.add(fbox(0.07, 0.1, 0.17, c=0.01), Gy, (sx * 0.2, 0.18, 0.0), panel=0.004)
    chest.add(fbox(0.11, 0.15, 0.04, bx=0.55, tz=0.9, c=0.008, cy=0.02), W, (0, 0.105, 0.135), (-0.12, 0, 0), panel=0.003)
    # lower chest / ribcage closing the gap to the abdomen
    chest.add(fbox(0.3, 0.1, 0.21, bx=0.72, bz=0.85, c=0.01, cy=0.04), B, (0, 0.02, 0.01), panel=0.005)
    for s, sx in SIDES:
        chest.add(fbox(0.06, 0.08, 0.16, c=0.008), Gy, (sx * 0.13, 0.03, -0.005), (0, 0, sx * 0.25), panel=0.003)
    chest.add(cyl(0.031, 0.026, 28, 'z'), C, (0, 0.12, 0.158), bevel=0.0015, seg=1)
    chest.add(cyl(0.022, 0.03, 28, 'z'), 'mech_glow', (0, 0.12, 0.163), bevel=0, smooth=False)
    chest.add(fbox(0.2, 0.045, 0.16, c=0.01), W, (0, 0.258, -0.012))
    # backpack + main thrusters + spare saber hilt
    chest.add(fbox(0.28, 0.26, 0.11, tx=1.06, bz=0.9, c=0.012, cy=0.03), W, (0, 0.135, -0.162), panel=0.006)
    chest.add(fbox(0.17, 0.17, 0.04, c=0.008), Gy, (0, 0.12, -0.228), panel=0.004)
    chest.decal('caution', (0, 0.12, -0.228), (0, 0, 0), (0, 0.045, -0.0202), (0, 0, -1), (-1, 0, 0), 0.11, 0.032)
    chest.add(fbox(0.012, 0.13, 0.012), R, (0, 0.12, -0.25))
    for s, sx in SIDES:
        chest.add(fbox(0.075, 0.08, 0.08, c=0.012), F, (sx * 0.075, 0.045, -0.2))
        chest.nozzle((sx * 0.075, 0.0, -0.205), (0, -0.85, -0.5), r=0.042, length=0.075, name=f'jet_back_{s}')
    chest.add(cyl(0.016, 0.12, 14), F, (-0.06, 0.29, -0.2), (0.25, 0, 0.15), bevel=0.002)
    chest.add(cyl(0.02, 0.025, 14), C, (-0.068, 0.35, -0.215), (0.25, 0, 0.15), bevel=0.0015)
    # flight wings: two-layer binders hinged on the backpack
    for s, sx in SIDES:
        base = Vector((sx * 0.13, 0.21, -0.225))
        for layer, (r, L, w) in enumerate((((-0.55, 0, sx * -0.42), 0.52, 0.09), ((-0.7, 0, sx * -0.85), 0.4, 0.07))):
            M = rot_m(r).to_3x3()
            at = lambda p: tuple(base + M @ Vector(p))
            chest.add(fbox(w, L, 0.05, tx=0.45, tz=0.7, c=0.006, cy=0.012), W, at((0, L * 0.45, -0.02 * layer)), r, panel=0.004)
            chest.add(fbox(w * 0.6, L * 0.6, 0.02, tx=0.5, c=0.004), B, at((sx * 0.004, L * 0.4, 0.03 - 0.02 * layer)), r, panel=0.002)
            chest.add(fbox(0.012, L * 0.7, 0.012, tx=0.6), R if layer == 0 else G, at((sx * w * 0.42, L * 0.45, 0.0)), r)
        M = rot_m((-0.55, 0, sx * -0.42)).to_3x3()
        chest.add(fbox(0.085, 0.08, 0.085, bx=1.15, bz=1.15, c=0.012), F, tuple(base + M @ Vector((0, -0.04, -0.005))), (-0.55, 0, sx * -0.42))
        chest.nozzle(tuple(base + M @ Vector((0, -0.08, -0.005))), tuple(M @ Vector((0, -1, -0.2))), r=0.034, length=0.055, name=f'jet_wing_{s}')

    # ================= neck / head (brow visor, cheek guards, slatted face mask, twin eyes, gold crest)
    neck.add(cyl(0.04, 0.09, 18), K, (0, 0.02, 0), bevel=0)
    for k in range(3):
        neck.add(cyl(0.046 - k * 0.002, 0.01, 18), Gy, (0, -0.01 + k * 0.025, 0), bevel=0.0015, seg=1)
    for s, sx in SIDES:
        neck.piston((sx * 0.04, -0.03, -0.02), (sx * 0.03, 0.06, -0.02), r=0.006)
    head.add(fbox(0.105, 0.1, 0.125, tx=0.82, tz=0.78, bz=0.95, sz=-0.01, c=0.012, cy=0.022, cx=0.018), W, (0, 0.085, -0.012), panel=0.0025)
    head.add(fbox(0.11, 0.03, 0.06, bx=0.92, tz=0.7, sz=-0.01, c=0.008), W, (0, 0.118, 0.045), (0.25, 0, 0))   # brow visor
    head.add(fbox(0.086, 0.028, 0.02, bx=0.8, c=0.004), F, (0, 0.093, 0.058))                               # eye recess
    for s, sx in SIDES:
        head.add(fbox(0.03, 0.011, 0.012, tx=0.55, c=0.002), 'mech_eye', (sx * 0.021, 0.094, 0.066), (0, 0, sx * -0.18), bevel=0.0008, seg=1)
        head.add(fbox(0.02, 0.075, 0.08, tz=0.7, bsz=0.015, c=0.006), W, (sx * 0.055, 0.06, 0.04), (0, sx * 0.25, 0), panel=0.002)  # cheek guards
        head.add(cyl(0.02, 0.03, 18, 'x'), Gy, (sx * 0.06, 0.09, -0.005), bevel=0.002)
        head.add(cyl(0.007, 0.02, 10, 'z'), F, (sx * 0.06, 0.104, 0.018), bevel=0)
        blade = fbox(0.016, 0.17, 0.01, tx=0.15, tz=0.5, c=0.003)
        bmesh.ops.translate(blade, verts=blade.verts, vec=Vector((0, 0.085, 0)))
        head.add(blade, G, (sx * 0.01, 0.13, 0.072), (-0.15, 0, sx * -1.0), bevel=0.0012)
        head.add(fbox(0.01, 0.03, 0.1, tz=0.3, c=0.003), W, (sx * 0.05, 0.14, -0.04), (-0.5, sx * 0.25, sx * -0.2))
    head.add(fbox(0.07, 0.05, 0.045, bx=0.45, tz=0.85, c=0.006, cy=0.012), W, (0, 0.045, 0.06), (0.12, 0, 0))     # face mask
    for k in range(3):
        head.add(fbox(0.022, 0.005, 0.006, c=0.001), F, (0, 0.058 - k * 0.009, 0.083), (0.12, 0, 0), bevel=0.0008, seg=1)
    head.add(fbox(0.03, 0.018, 0.026, bx=0.5, c=0.004), R, (0, 0.019, 0.075))
    head.add(fbox(0.026, 0.024, 0.02, bx=0.6, c=0.004), R, (0, 0.13, 0.078))
    head.add(fbox(0.018, 0.05, 0.12, tz=0.35, sz=-0.03, c=0.004), W, (0, 0.152, -0.045), (0.3, 0, 0))
    head.add(fbox(0.04, 0.03, 0.02, c=0.004), 'mech_eye', (0, 0.1, -0.078), bevel=0.001)

    # ================= arms
    for s, sx in SIDES:
        sh, el, ha = arms[s]
        sh.add(sphere(0.056), C, bevel=0)
        # layered pauldron: core block, top cap, outer and front/back flaps
        sh.add(fbox(0.21, 0.19, 0.25, tx=0.84, bz=0.9, c=0.012, cy=0.04, cx=0.02), W, (sx * 0.07, 0.045, 0), (0, 0, sx * -0.12), panel=0.008)
        sh.add(fbox(0.23, 0.04, 0.27, tx=0.92, c=0.008, cy=0.03), B, (sx * 0.072, 0.162, 0), (0, 0, sx * -0.22), panel=0.006)
        sh.add(fbox(0.034, 0.23, 0.24, bz=0.78, c=0.008, cz=0.02), W, (sx * 0.186, -0.01, 0), (0, 0, sx * 0.13), panel=0.006)
        sh.decal('num', (sx * 0.186, -0.01, 0), (0, 0, sx * 0.13), (sx * 0.0172, -0.055, 0.0), (sx, 0, 0), (0, 0, -sx), 0.13, 0.075)
        sh.add(fbox(0.01, 0.045, 0.17, c=0.003), R, (sx * 0.205, 0.05, 0), (0, 0, sx * 0.13))
        sh.add(fbox(0.012, 0.03, 0.05, c=0.003), G, (sx * 0.205, -0.06, 0.06), (0, 0, sx * 0.13))
        for zz in (1, -1):
            sh.add(fbox(0.16, 0.14, 0.022, tx=0.8, c=0.006), W, (sx * 0.08, 0.0, zz * 0.13), (zz * 0.18, 0, sx * -0.12), panel=0.004)
        sh.nozzle((sx * 0.08, 0.1, -0.14), (0, 0.2, -1), r=0.022, length=0.035, name=f'jet_sh_{s}')
        sh.add(lathe([(-UA, 0.04, 0.04), (-UA * 0.5, 0.047, 0.047), (0, 0.043, 0.043)], 16), K, bevel=0)
        sh.add(fbox(0.1, 0.15, 0.1, tx=1.06, tz=1.06, c=0.008, cy=0.02), W, (0, -0.19, 0), panel=0.004)
        sh.add(fbox(0.104, 0.02, 0.104, c=0.004), Gy, (0, -0.105, 0))
        sh.piston((sx * 0.035, -0.1, -0.05), (sx * 0.035, -0.29, -0.045))
        # elbow + forearm gauntlet with an outer blade plate and red cuff
        el.add(cyl(0.048, 0.1, 20, 'x'), F, bevel=0.002)
        el.add(cyl(0.03, 0.104, 20, 'x'), C, bevel=0)
        el.add(fbox(0.12, 0.2, 0.125, bx=0.84, bz=0.86, c=0.01, cy=0.03), W, (0, -0.135, 0.004), panel=0.005)
        el.add(fbox(0.03, 0.18, 0.1, tz=0.8, c=0.006), B, (sx * 0.068, -0.14, 0.004), panel=0.003)
        el.add(fbox(0.07, 0.11, 0.014, c=0.004), Gy, (0, -0.13, 0.068), panel=0.0015)
        el.add(fbox(0.135, 0.036, 0.145, c=0.008), R, (0, -0.245, 0.004))
        el.add(fbox(0.02, 0.06, 0.012), G, (sx * 0.084, -0.2, 0.004))
        el.add(fbox(0.012, 0.05, 0.06, c=0.003), F, (-sx * 0.061, -0.17, 0.004))
        for k in range(3):
            el.add(fbox(0.006, 0.006, 0.05, c=0.001), Gy, (-sx * 0.067, -0.155 - k * 0.014, 0.004), bevel=0.0008, seg=1)
        el.add(fbox(0.09, 0.012, 0.13, c=0.003), F, (0, -0.205, 0.004))
        # hand: palm, back plate, palm emitter, three-joint fingers and thumb
        ha.add(fbox(0.07, 0.07, 0.08, c=0.01), F, (0, -0.038, 0.01))
        ha.add(fbox(0.074, 0.05, 0.026, tz=0.8, c=0.006), W, (sx * 0.0, -0.035, 0.05), (0.1, 0, 0))
        ha.add(cyl(0.014, 0.004, 16, 'x'), 'mech_glow', (sx * -0.036, -0.04, 0.01), bevel=0, smooth=False)
        for i in range(4):
            fx = (i - 1.5) * 0.017
            base = Vector((fx, -0.075, 0.02))
            a = 0.0
            for j, L in enumerate((0.028, 0.022, 0.018)):
                a += 0.5
                d = Vector((0, -math.cos(a), math.sin(a)))
                ha.add(fbox(0.015, L, 0.016, c=0.003), K if j < 2 else F, tuple(base + d * L / 2), (-a, 0, 0), bevel=0.001)
                base = base + d * L
        ha.add(fbox(0.018, 0.035, 0.018, c=0.003), K, (sx * 0.04, -0.05, 0.035), (0.4, 0, sx * 0.5), bevel=0.001)

    # ================= legs
    for s, sx in SIDES:
        th, kn, an = legs[s]
        th.add(sphere(0.062), C, bevel=0)
        th.add(lathe([(-TH, 0.054, 0.056), (-TH * 0.55, 0.066, 0.068), (-0.05, 0.06, 0.063)], 18), K, bevel=0)
        th.add(fbox(0.16, 0.28, 0.06, bx=0.82, c=0.008, cy=0.025), W, (0, -0.205, 0.058), (-0.03, 0, 0), panel=0.006)
        th.decal('text', (0, -0.205, 0.058), (-0.03, 0, 0), (0, 0.075, 0.0302), (0, 0, 1), (1, 0, 0), 0.085, 0.022)
        th.add(fbox(0.035, 0.27, 0.14, bz=0.85, c=0.008, cz=0.015), W, (sx * 0.075, -0.21, 0.0), panel=0.005)
        th.add(fbox(0.035, 0.24, 0.12, c=0.008), Gy, (-sx * 0.06, -0.22, -0.005), panel=0.004)
        th.add(fbox(0.12, 0.2, 0.04, c=0.008), Gy, (0, -0.22, -0.06), panel=0.004)
        th.add(fbox(0.016, 0.12, 0.012), B, (sx * 0.094, -0.21, 0.04))
        th.add(fbox(0.13, 0.09, 0.13, bx=0.85, c=0.01, cy=0.03), Gy, (0, -0.375, 0.0), panel=0.003)
        th.piston((sx * 0.04, -0.08, -0.07), (sx * 0.04, -0.4, -0.06))
        # knee
        kn.add(cyl(0.054, 0.12, 20, 'x'), F, bevel=0.002)
        kn.add(cyl(0.034, 0.124, 20, 'x'), C, bevel=0)
        kn.add(fbox(0.13, 0.15, 0.1, tx=0.55, tz=0.66, sz=0.012, c=0.008, cy=0.03), W, (0, 0.01, 0.08), (-0.26, 0, 0), panel=0.003)
        kn.add(fbox(0.04, 0.05, 0.018, bx=0.55, c=0.004), R, (0, -0.02, 0.133), (-0.26, 0, 0))
        # shin: front plate, side armour, blue shin guard, calf thruster block
        kn.add(fbox(0.19, 0.37, 0.2, bx=0.78, bz=0.8, sz=-0.015, c=0.012, cy=0.068, cx=0.02), W, (0, -0.23, -0.01), panel=0.006)
        kn.add(fbox(0.075, 0.3, 0.035, bx=0.75, c=0.006, cy=0.018), B, (0, -0.22, 0.096), panel=0.003)
        kn.add(fbox(0.034, 0.25, 0.12, tz=0.9, c=0.008), W, (sx * 0.1, -0.24, -0.015), panel=0.004)
        kn.decal('warn', (sx * 0.1, -0.24, -0.015), (0, 0, 0), (sx * 0.0172, 0.085, 0), (sx, 0, 0), (0, 0, -sx), 0.085, 0.022)
        kn.add(fbox(0.012, 0.08, 0.06, c=0.003), F, (sx * 0.118, -0.26, -0.015))
        for k in range(3):
            kn.add(fbox(0.006, 0.007, 0.05, c=0.001), G, (sx * 0.124, -0.235 - k * 0.02, -0.015), bevel=0.0008, seg=1)
        kn.add(fbox(0.15, 0.18, 0.07, c=0.01, cy=0.02), B, (0, -0.27, -0.12), (0.14, 0, 0), panel=0.004)
        kn.piston((sx * 0.06, -0.06, -0.08), (sx * 0.06, -0.3, -0.095))
        for nx in (1, -1):
            kn.nozzle((nx * 0.04, -0.37, -0.14), (0, -0.75, -0.66), r=0.024, length=0.04, name=f'jet_calf_{s}' if nx == sx else None)
        kn.add(fbox(0.17, 0.07, 0.18, c=0.01), Gy, (0, -0.415, 0), panel=0.004)
        # foot
        an.add(sphere(0.046), C, bevel=0)
        an.add(fbox(0.16, 0.075, 0.3, tx=0.8, tz=0.72, sz=0.02, c=0.008, cy=0.03, cx=0.02), W, (0, -0.058, 0.06), panel=0.005)
        an.add(fbox(0.15, 0.05, 0.1, tz=0.55, c=0.008, cy=0.02), B, (0, -0.072, 0.245), (0.28, 0, 0), panel=0.002)
        an.add(fbox(0.13, 0.055, 0.075, c=0.01), Gy, (0, -0.074, -0.1))
        an.decal('warn', (0, -0.074, -0.1), (0, 0, 0), (0, 0.0, -0.0377), (0, 0, -1), (-1, 0, 0), 0.1, 0.022)
        an.add(fbox(0.175, 0.016, 0.33, c=0.004), F, (0, -0.093, 0.065))
        for zz in (1, -1):
            an.add(fbox(0.02, 0.07, 0.09, c=0.005), W, (zz * 0.088, -0.03, 0.0), (0, 0, zz * -0.15))
        an.nozzle((0, -0.098, 0.0), (0, -1, 0), r=0.03, length=0.01, name=f'jet_foot_{s}')

    # sword socket: local +Z along the blade (set by the game)
    arms['R'][2].anchor('socket_R', (0, -0.065, 0.02), None)


def finalize():
    objs = {}
    for name, p in PARTS.items():
        bm = bmesh.new()
        for me in p.pieces:
            bm.from_mesh(me)
            bpy.data.meshes.remove(me)
        uv = bm.loops.layers.uv.get('UVMap') or bm.loops.layers.uv.new('UVMap')
        k = 3.1 / 1.5   # box-projected UVs, ~1.5 m per tile in game
        decal_idx = {i for i, m in enumerate(p.mats) if m.startswith('mech_decal')}
        for f in bm.faces:
            if f.material_index in decal_idx:
                continue
            nrm = f.normal
            ax = max(range(3), key=lambda i: abs(nrm[i]))
            for l in f.loops:
                c = l.vert.co
                l[uv].uv = (c.y * k, c.z * k) if ax == 0 else (c.x * k, c.z * k) if ax == 1 else (c.x * k, c.y * k)
        me = bpy.data.meshes.new(name)
        bm.to_mesh(me)
        bm.free()
        for m in p.mats:
            me.materials.append(mat(m))
        ob = bpy.data.objects.new(name, me)
        SCENE.collection.objects.link(ob)
        objs[name] = ob
    root = bpy.data.objects.new('mech', None)
    SCENE.collection.objects.link(root)
    for name, p in PARTS.items():
        ob = objs[name]
        ob.parent = objs[p.parent] if p.parent else root
        ob.location = T(p.world - (PARTS[p.parent].world if p.parent else Vector((0, 0, 0))))
        for (an, pos, d) in p.anchors:
            e = bpy.data.objects.new('anchor_' + an, None)
            SCENE.collection.objects.link(e)
            e.empty_display_size = 0.02
            e.parent = ob
            e.location = T(pos)
            if d is not None:
                e.rotation_mode = 'QUATERNION'
                e.rotation_quaternion = Vector((0, 0, -1)).rotation_difference(T(d))   # three.js local -Y along exhaust
    tris = sum(len(o.data.polygons) for o in objs.values())
    print(f'MECH parts={len(objs)} faces={tris}')
    return root


def preview():
    if not PREVIEW:
        return
    os.makedirs(PREVIEW, exist_ok=True)
    sc = SCENE
    sc.render.engine = 'BLENDER_EEVEE'
    world = bpy.data.worlds.new('w')
    sc.world = world
    if world.node_tree is None:
        world.use_nodes = True
    bg = world.node_tree.nodes.get('Background')
    bg.inputs[0].default_value = (0.03, 0.033, 0.04, 1)
    gme = bpy.data.meshes.new('g')
    gb = bmesh.new()
    bmesh.ops.create_grid(gb, x_segments=1, y_segments=1, size=6)
    gb.to_mesh(gme)
    gob = bpy.data.objects.new('ground', gme)
    sc.collection.objects.link(gob)
    gm = bpy.data.materials.new('groundm')
    gm.diffuse_color = (0.2, 0.2, 0.2, 1)
    gme.materials.append(gm)

    def light(kind, loc, energy, size=1.0, color=(1, 1, 1)):
        ld = bpy.data.lights.new('l', kind)
        ld.energy = energy
        ld.color = color
        if kind == 'AREA':
            ld.size = size
        lo = bpy.data.objects.new('l', ld)
        lo.location = loc
        lo.rotation_euler = (Vector((0, 0, 1.0)) - Vector(loc)).to_track_quat('-Z', 'Y').to_euler()
        sc.collection.objects.link(lo)
    light('SUN', (3, -2, 5), 3.5)
    light('AREA', (-3, -2.5, 2), 300, 3, (0.7, 0.8, 1.0))
    light('AREA', (0.5, 3, 2.5), 450, 2, (1.0, 0.85, 0.7))
    cd = bpy.data.cameras.new('cam')
    cam = bpy.data.objects.new('cam', cd)
    sc.collection.objects.link(cam)
    sc.camera = cam
    sc.render.resolution_x, sc.render.resolution_y = 1000, 1200
    views = {
        'front': ((0, 0, 0.95), (0.9, -2.6, 0.45), 1.45, 50),
        'back': ((0, 0, 1.0), (-1.3, 2.4, 0.9), 1.45, 50),
        'side': ((0, 0, 0.95), (2.8, -0.6, 0.35), 1.15, 50),
        'torso': ((0, 0, 1.45), (0.8, -2.3, 0.4), 0.42, 50),
        'legs': ((0, 0, 0.45), (1.0, -2.4, 0.5), 0.45, 50),
    }
    for n, (tgt, d, dist, lens) in views.items():
        cd.lens = lens
        tgt = Vector(tgt)
        cam.location = tgt + Vector(d).normalized() * dist * 2.4
        cam.rotation_euler = (tgt - cam.location).to_track_quat('-Z', 'Y').to_euler()
        sc.render.filepath = os.path.join(PREVIEW, f'mech_{n}.png')
        bpy.ops.render.render(write_still=True)


build()
root = finalize()
path = os.path.join(OUT, 'mech_lo.glb' if LOD else 'mech.glb')
bpy.ops.export_scene.gltf(filepath=path, export_format='GLB', export_yup=True, export_apply=True,
                          export_draco_mesh_compression_enable=True, export_draco_mesh_compression_level=7)
print(f'EXPORTED {path} ({os.path.getsize(path) // 1024} KB)')
if not LOD:
    preview()
print('DONE')
