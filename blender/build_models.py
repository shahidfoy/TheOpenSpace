"""Builds The Open Space hero models procedurally and exports GLBs.

Run:  blender --background --factory-startup --python blender/build_models.py -- public/models [preview_dir] [names...]

Conventions (Blender space): forward = -Y, up = +Z, right = +X.
glTF export maps that to three.js forward = +Z, up = +Y.
Named empties (anchor_*) mark attachment points the game reads at runtime.
Articulated models (mech) are split into parts whose origins sit on their joints.
Every face gets box-projected UVs in metres (x uvscale / 4), so the game's tiling
panel/grime textures (src/render/materials.js) land at a consistent size. Materials
are matched by name at runtime and swapped for the textured PBR set.
"""
import bpy
import bmesh
import math
import os
import random
import sys
from mathutils import Vector, Matrix, Euler

argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
OUT = os.path.abspath(argv[0] if argv else 'public/models')
PREVIEW = os.path.abspath(argv[1]) if len(argv) > 1 and argv[1] != '-' else None
os.makedirs(OUT, exist_ok=True)
if PREVIEW:
    os.makedirs(PREVIEW, exist_ok=True)

# ---------------------------------------------------------------- materials
# (base linear rgb, metallic, roughness, emission rgb, emission strength)
PALETTE = {
    'hull':       ((0.11, 0.112, 0.12), 0.7, 0.45, None, 0),
    'hullLight':  ((0.55, 0.55, 0.53), 0.2, 0.5, None, 0),
    'hullDark':   ((0.025, 0.026, 0.03), 0.75, 0.5, None, 0),
    'accent':     ((0.85, 0.25, 0.02), 0.2, 0.5, None, 0),
    'yellow':     ((0.8, 0.5, 0.02), 0.2, 0.5, None, 0),
    'paintRed':   ((0.35, 0.05, 0.03), 0.3, 0.55, None, 0),
    'paintBlue':  ((0.04, 0.12, 0.3), 0.3, 0.55, None, 0),
    'paintOlive': ((0.17, 0.18, 0.06), 0.3, 0.6, None, 0),
    'paintTeal':  ((0.02, 0.2, 0.2), 0.3, 0.55, None, 0),
    'paintWhite': ((0.6, 0.6, 0.58), 0.2, 0.55, None, 0),
    'foil':       ((0.75, 0.5, 0.12), 1.0, 0.3, None, 0),
    'solar':      ((0.02, 0.04, 0.12), 0.9, 0.25, None, 0),
    'glass':      ((0.01, 0.015, 0.02), 1.0, 0.05, (0.9, 0.55, 0.15), 0.3),
    'window':     ((0, 0, 0), 0, 0.5, (1.0, 0.75, 0.4), 1.5),
    'cyan':       ((0, 0, 0), 0, 0.5, (0.0, 0.85, 1.0), 2.0),
    'magenta':    ((0, 0, 0), 0, 0.5, (1.0, 0.06, 0.65), 2.0),
    'amber':      ((0, 0, 0), 0, 0.5, (1.0, 0.45, 0.04), 2.0),
    'red':        ((0, 0, 0), 0, 0.5, (1.0, 0.03, 0.05), 3.0),
    'green':      ((0, 0, 0), 0, 0.5, (0.05, 1.0, 0.3), 3.0),
    'engine':     ((0, 0, 0), 0, 0.5, (0.35, 0.7, 1.0), 1.2),
    'engineHot':  ((0, 0, 0), 0, 0.5, (0.6, 0.85, 1.0), 2.0),
}
MATS = {}


def get_mat(name):
    if name in MATS:
        return MATS[name]
    base, metal, rough, emit, strength = PALETTE[name]
    m = bpy.data.materials.new(name)
    try:
        m.use_nodes = True
    except Exception:
        pass
    nodes = m.node_tree.nodes
    bsdf = next((n for n in nodes if n.type == 'BSDF_PRINCIPLED'), None)
    if bsdf is None:
        bsdf = nodes.new('ShaderNodeBsdfPrincipled')
        out = next((n for n in nodes if n.type == 'OUTPUT_MATERIAL'), None) or nodes.new('ShaderNodeOutputMaterial')
        m.node_tree.links.new(bsdf.outputs[0], out.inputs[0])
    bsdf.inputs['Base Color'].default_value = (*base, 1)
    bsdf.inputs['Metallic'].default_value = metal
    bsdf.inputs['Roughness'].default_value = rough
    if emit:
        bsdf.inputs['Emission Color'].default_value = (*emit, 1)
        bsdf.inputs['Emission Strength'].default_value = strength
    m.diffuse_color = (*(emit if emit and strength > 1 else base), 1)
    m.metallic = metal
    m.roughness = rough
    MATS[name] = m
    return m


def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    MATS.clear()


# ---------------------------------------------------------------- primitives
def bm_box(sx, sy, sz):
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1)
    for v in bm.verts:
        v.co = Vector((v.co.x * sx, v.co.y * sy, v.co.z * sz))
    return bm


def bm_hexa(bottom, top):
    """Convex hexahedron from a bottom loop of 4 points and the matching top loop."""
    bm = bmesh.new()
    vs = [bm.verts.new(p) for p in list(bottom) + list(top)]
    for f in ((0, 1, 2, 3), (7, 6, 5, 4), (0, 4, 5, 1), (1, 5, 6, 2), (2, 6, 7, 3), (3, 7, 4, 0)):
        bm.faces.new([vs[i] for i in f])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return bm


def taper_pts(w, l, h, front=(1, 1), back=(1, 1), fz=0.0, bz=0.0):
    """Box along Y whose front (-Y) and back (+Y) faces are scaled (x, z) and shifted in z."""
    y0, y1 = -l / 2, l / 2
    fw, fh = w / 2 * front[0], h / 2 * front[1]
    bw, bh = w / 2 * back[0], h / 2 * back[1]
    bottom = [(-fw, y0, fz - fh), (fw, y0, fz - fh), (bw, y1, bz - bh), (-bw, y1, bz - bh)]
    top = [(-fw, y0, fz + fh), (fw, y0, fz + fh), (bw, y1, bz + bh), (-bw, y1, bz + bh)]
    return bottom, top


def slab(fr, br, ft, bt, t_root, t_tip):
    """Wing-like slab: root/tip leading (f) and trailing (b) centre points, thickness at root/tip."""
    def lo(p, t): return (p[0], p[1], p[2] - t / 2)
    def hi(p, t): return (p[0], p[1], p[2] + t / 2)
    return bm_hexa([lo(fr, t_root), lo(ft, t_tip), lo(bt, t_tip), lo(br, t_root)],
                   [hi(fr, t_root), hi(ft, t_tip), hi(bt, t_tip), hi(br, t_root)])


def bm_cyl(r1, r2, depth, seg=16, axis='y'):
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=True, cap_tris=False, segments=seg, radius1=r1, radius2=r2, depth=depth)
    rot = {'y': Matrix.Rotation(-math.pi / 2, 4, 'X'), 'x': Matrix.Rotation(math.pi / 2, 4, 'Y'), 'z': Matrix.Identity(4)}[axis]
    bmesh.ops.transform(bm, matrix=rot, verts=bm.verts)
    return bm


def bm_seg(a, b, r, seg=8):
    """Cylinder strut from point a to point b."""
    a, b = Vector(a), Vector(b)
    d = b - a
    bm = bm_cyl(r, r, d.length, seg, 'y')
    m = Matrix.Translation((a + b) / 2) @ Vector((0, 1, 0)).rotation_difference(d.normalized()).to_matrix().to_4x4()
    bmesh.ops.transform(bm, matrix=m, verts=bm.verts)
    return bm


def bm_sphere(r, seg=24, rings=14):
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=seg, v_segments=rings, radius=r)
    return bm


def bm_torus(R, r, seg=32, rseg=8, axis='z', sx=1.0):
    """Torus; sx stretches the tube cross-section radially (flat ring bands)."""
    bm = bmesh.new()
    rings = []
    for i in range(seg):
        a = 2 * math.pi * i / seg
        ring = []
        for j in range(rseg):
            b = 2 * math.pi * j / rseg
            d = R + r * sx * math.cos(b)
            ring.append(bm.verts.new((d * math.cos(a), d * math.sin(a), r * math.sin(b))))
        rings.append(ring)
    for i in range(seg):
        for j in range(rseg):
            a, b = rings[i], rings[(i + 1) % seg]
            bm.faces.new((a[j], b[j], b[(j + 1) % rseg], a[(j + 1) % rseg]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    rot = {'z': Matrix.Identity(4), 'y': Matrix.Rotation(math.pi / 2, 4, 'X'), 'x': Matrix.Rotation(math.pi / 2, 4, 'Y')}[axis]
    bmesh.ops.transform(bm, matrix=rot, verts=bm.verts)
    return bm


def basis(u, v, n, c):
    """4x4 matrix whose local X/Y/Z axes are u/v/n, placed at c."""
    m = Matrix((Vector(u).normalized(), Vector(v).normalized(), Vector(n).normalized())).transposed().to_4x4()
    m.translation = Vector(c)
    return m


# ---------------------------------------------------------------- mesh groups
class Group:
    """Accumulates bevelled primitives into one mesh (one draw call per material)."""

    def __init__(self, name, uvscale=1.0):
        self.name = name
        self.uvscale = uvscale / 4.0
        self.bm = bmesh.new()
        self.mats = []

    def add(self, pbm, mat, loc=(0, 0, 0), rot=(0, 0, 0), bevel=0.03, seg=2, smooth=True, pre=None):
        if bevel > 0:
            edges = [e for e in pbm.edges if e.is_manifold and e.calc_face_angle(0) > math.radians(30)]
            if edges:
                bmesh.ops.bevel(pbm, geom=edges, offset=bevel, segments=seg, profile=0.5, affect='EDGES', clamp_overlap=True)
        m = Matrix.Translation(Vector(loc)) @ Euler(rot).to_matrix().to_4x4()
        if pre is not None:
            m = pre
        bmesh.ops.transform(pbm, matrix=m, verts=pbm.verts)
        pbm.normal_update()
        # box-projected UVs, metres x uvscale
        uv = pbm.loops.layers.uv.get('UVMap') or pbm.loops.layers.uv.new('UVMap')
        k = self.uvscale
        for f in pbm.faces:
            n = f.normal
            ax = max(range(3), key=lambda i: abs(n[i]))
            for l in f.loops:
                c = l.vert.co
                l[uv].uv = (c.y * k, c.z * k) if ax == 0 else (c.x * k, c.z * k) if ax == 1 else (c.x * k, c.y * k)
        if mat not in self.mats:
            self.mats.append(mat)
        mi = self.mats.index(mat)
        for f in pbm.faces:
            f.material_index = mi
            f.smooth = smooth
        for e in pbm.edges:
            e.smooth = not (e.is_manifold and e.calc_face_angle(0) > math.radians(50))
        tmp = bpy.data.meshes.new('tmp')
        pbm.to_mesh(tmp)
        pbm.free()
        self.bm.from_mesh(tmp)
        bpy.data.meshes.remove(tmp)
        return self

    # shorthands
    def box(self, size, loc, mat, bevel=0.03, rot=(0, 0, 0)):
        return self.add(bm_box(*size), mat, loc, rot, bevel)

    def obox(self, size, c, u, v, n, mat, bevel=0.02):
        """Box oriented on arbitrary axes (size along u, v, n)."""
        return self.add(bm_box(*size), mat, bevel=bevel, pre=basis(u, v, n, c))

    def hexa(self, pts, mat, loc=(0, 0, 0), bevel=0.03, rot=(0, 0, 0)):
        return self.add(bm_hexa(*pts), mat, loc, rot, bevel)

    def cyl(self, r1, r2, depth, loc, mat, axis='y', seg=16, bevel=0.015, rot=(0, 0, 0)):
        return self.add(bm_cyl(r1, r2, depth, seg, axis), mat, loc, rot, bevel)

    def seg(self, a, b, r, mat, seg=8, bevel=0.0):
        return self.add(bm_seg(a, b, r, seg), mat, bevel=bevel)

    def sphere(self, r, loc, mat, scale=(1, 1, 1), seg=24, rings=14):
        bm = bm_sphere(r, seg, rings)
        bmesh.ops.scale(bm, vec=Vector(scale), verts=bm.verts)
        return self.add(bm, mat, loc, bevel=0)

    def torus(self, R, r, loc, mat, axis='z', seg=32, rseg=8, sx=1.0):
        return self.add(bm_torus(R, r, seg, rseg, axis, sx), mat, loc, bevel=0)

    def greeble(self, rng, c, u, v, n, w, h, count, mats=('hullDark', 'hull'), hmax=0.08, smax=0.35):
        """Scatter small boxes over a w x h rectangle centred at c on the plane (u, v) facing n."""
        c, u, v, n = Vector(c), Vector(u).normalized(), Vector(v).normalized(), Vector(n).normalized()
        for _ in range(count):
            sw, sh = rng.uniform(0.06, smax), rng.uniform(0.06, smax)
            hh = rng.uniform(0.02, hmax)
            p = c + u * rng.uniform(-(w - sw) / 2, (w - sw) / 2) + v * rng.uniform(-(h - sh) / 2, (h - sh) / 2) + n * (hh / 2)
            self.obox((sw, sh, hh), p, u, v, n, rng.choice(mats), bevel=0.006 if min(sw, sh) > 0.1 else 0)
        return self

    def build(self, origin=(0, 0, 0), parent=None):
        o = Vector(origin)
        bmesh.ops.translate(self.bm, vec=-o, verts=self.bm.verts)
        me = bpy.data.meshes.new(self.name)
        self.bm.to_mesh(me)
        self.bm.free()
        for name in self.mats:
            me.materials.append(get_mat(name))
        obj = bpy.data.objects.new(self.name, me)
        bpy.context.scene.collection.objects.link(obj)
        if parent is not None:
            obj.parent = parent
            obj.location = o - parent.matrix_world.translation
        else:
            obj.location = o
        bpy.context.view_layer.update()
        return obj


def empty(name, loc, parent=None):
    e = bpy.data.objects.new(name, None)
    e.empty_display_size = 0.2
    bpy.context.scene.collection.objects.link(e)
    if parent is not None:
        e.parent = parent
        e.location = Vector(loc) - parent.matrix_world.translation
    else:
        e.location = loc
    bpy.context.view_layer.update()
    return e


X, Y, Z = Vector((1, 0, 0)), Vector((0, 1, 0)), Vector((0, 0, 1))


# ================================================================ SKIFF  (Kestrel salvage cutter)
def build_skiff():
    rng = random.Random(7)
    g = Group('skiff')
    # fuselage: armoured wedge + nose prong
    g.hexa(taper_pts(1.0, 3.6, 0.62, front=(0.38, 0.55), back=(1.0, 0.9), fz=0.0), 'hull', (0, -0.2, 0), bevel=0.05)
    g.hexa(taper_pts(0.52, 1.3, 0.34, front=(0.22, 0.3), fz=-0.05), 'hullLight', (0, -2.4, -0.04), bevel=0.04)
    g.hexa(taper_pts(0.8, 2.0, 0.12, front=(0.5, 1)), 'hullLight', (0, -0.9, -0.33), bevel=0.03)
    # cockpit canopy with frame ribs
    g.sphere(1, (0, -1.0, 0.3), 'glass', scale=(0.34, 0.95, 0.25), seg=28, rings=14)
    for y in (-1.55, -1.05, -0.55):
        g.box((0.62, 0.05, 0.06), (0, y, 0.43 - abs(y + 1.0) * 0.18), 'hullDark', bevel=0.01)
    g.box((0.05, 1.7, 0.05), (0, -1.0, 0.55), 'hullDark', bevel=0.01)
    # dorsal spine with orange stripe and sensor hump
    g.box((0.36, 2.3, 0.2), (0, 0.55, 0.38), 'hullLight', bevel=0.04)
    g.box((0.38, 1.4, 0.02), (0, 0.5, 0.49), 'accent', bevel=0)
    g.hexa(taper_pts(0.3, 0.6, 0.18, front=(0.6, 0.5)), 'hullDark', (0, 1.55, 0.55), bevel=0.03)
    g.cyl(0.012, 0.012, 0.6, (0.12, 1.6, 0.85), 'hullDark', axis='z', seg=6, bevel=0)
    g.sphere(0.035, (0.12, 1.6, 1.15), 'red', seg=8, rings=6)
    g.greeble(rng, (0, 0.2, 0.31), X, Y, Z, 0.9, 1.4, 10)
    # belly mining laser
    g.cyl(0.08, 0.08, 1.2, (0, -1.9, -0.3), 'hullDark', seg=12)
    g.cyl(0.13, 0.13, 0.25, (0, -1.35, -0.3), 'hull', seg=12)
    g.cyl(0.05, 0.03, 0.18, (0, -2.55, -0.3), 'hullLight', seg=10)
    g.sphere(0.045, (0, -2.66, -0.3), 'red', seg=10, rings=6)
    g.box((0.5, 0.9, 0.16), (0, 0.3, -0.38), 'hullDark', bevel=0.03)

    for s in (-1, 1):
        x = lambda v: v * s
        # intakes
        g.hexa(taper_pts(0.3, 1.2, 0.36, front=(0.8, 0.8)), 'hullDark', (x(0.6), -0.3, 0.0), bevel=0.03)
        g.box((0.24, 0.04, 0.26), (x(0.6), -0.92, 0.0), 'amber', bevel=0)
        # swept wing, upper plate, orange tip
        g.add(slab((x(0.45), -0.4, -0.02), (x(0.45), 1.5, -0.02), (x(2.35), 1.05, 0.12), (x(2.35), 1.65, 0.12), 0.16, 0.06), 'hull', bevel=0.02)
        g.add(slab((x(0.7), 0.1, 0.06), (x(0.7), 1.25, 0.06), (x(1.8), 0.85, 0.15), (x(1.8), 1.45, 0.15), 0.03, 0.03), 'hullLight', bevel=0.008)
        g.add(slab((x(2.0), 0.95, 0.1), (x(2.0), 1.58, 0.1), (x(2.4), 1.08, 0.13), (x(2.4), 1.68, 0.13), 0.07, 0.06), 'accent', bevel=0.01)
        g.sphere(0.05, (x(2.42), 1.12, 0.13), 'red' if s < 0 else 'green', seg=10, rings=6)
        g.box((0.6, 0.04, 0.02), (x(1.4), 0.6, 0.16), 'cyan', bevel=0, rot=(0, 0, s * -0.42))
        # engine nacelle on a pylon
        g.box((0.4, 0.9, 0.22), (x(0.82), 1.4, 0.0), 'hullDark', bevel=0.03)
        g.cyl(0.33, 0.33, 1.6, (x(1.05), 1.55, 0.05), 'hullDark', seg=24)
        g.cyl(0.24, 0.33, 0.3, (x(1.05), 0.6, 0.05), 'hullLight', seg=24)
        g.cyl(0.18, 0.18, 0.05, (x(1.05), 0.45, 0.05), 'hullDark', seg=20, bevel=0)
        g.cyl(0.36, 0.4, 0.42, (x(1.05), 2.5, 0.05), 'hull', seg=24)
        g.cyl(0.29, 0.29, 0.04, (x(1.05), 2.72, 0.05), 'engine', seg=24, bevel=0)
        g.torus(0.37, 0.035, (x(1.05), 2.66, 0.05), 'engineHot', axis='y', seg=28, rseg=6)
        for y in (1.05, 1.6, 2.1):
            g.torus(0.335, 0.025, (x(1.05), y, 0.05), 'hullLight', axis='y', seg=24, rseg=5)
        g.box((0.04, 1.0, 0.1), (x(1.05 + 0.33), 1.55, 0.05), 'accent', bevel=0)
        # canted twin fin
        g.hexa(([(x(1.0), 1.6, 0.35), (x(1.1), 1.6, 0.35), (x(1.1), 2.45, 0.35), (x(1.0), 2.45, 0.35)],
                [(x(1.25), 2.15, 1.05), (x(1.3), 2.15, 1.05), (x(1.3), 2.55, 1.05), (x(1.25), 2.55, 1.05)]), 'hull', bevel=0.012)
        g.box((0.05, 0.3, 0.06), (x(1.28), 2.35, 1.0), 'amber', bevel=0)
        # RCS quads
        for y in (-1.6, 0.9):
            g.box((0.12, 0.12, 0.1), (x(0.42 if y < 0 else 0.55), y, 0.22), 'hullDark', bevel=0.01)
            g.box((0.03, 0.03, 0.03), (x(0.49 if y < 0 else 0.62), y, 0.22), 'amber', bevel=0)
        g.greeble(rng, (x(0.52), 0.6, 0.0), Y, Z, Vector((s, 0, 0)), 1.0, 0.3, 5)

    root = g.build()
    empty('anchor_nose', (0, -2.7, -0.3), root)
    empty('anchor_exhaust_0', (-1.05, 2.75, 0.05), root)
    empty('anchor_exhaust_1', (1.05, 2.75, 0.05), root)
    return root


# ================================================================ HAULER  (Mule container hauler)
def container(g, rng, c, size, paint):
    sx, sy, sz = size
    g.box(size, c, paint, bevel=0.04)
    cx, cy, cz = c
    # corrugation ribs on the four long faces
    n = 7
    for i in range(n):
        y = cy - sy / 2 + sy * (i + 0.5) / n
        g.box((sx + 0.05, 0.07, sz * 0.86), (cx, y, cz), paint, bevel=0)
        g.box((sx * 0.86, 0.07, sz + 0.05), (cx, y, cz), paint, bevel=0)
    for ex in (-1, 1):
        for ez in (-1, 1):
            for ey in (-1, 1):
                g.box((0.16, 0.16, 0.16), (cx + ex * (sx / 2 - 0.05), cy + ey * (sy / 2 - 0.05), cz + ez * (sz / 2 - 0.05)), 'hullDark', bevel=0)


def build_hauler():
    rng = random.Random(11)
    g = Group('hauler')
    # cab
    g.hexa(taper_pts(2.9, 2.6, 2.3, front=(0.75, 0.6), fz=-0.15), 'yellow', (0, -7.4, 0.1), bevel=0.1)
    g.hexa(taper_pts(2.2, 0.15, 0.55, front=(1, 1)), 'glass', (0, -8.62, 0.45), bevel=0.02, rot=(-0.45, 0, 0))
    for x in (-0.6, 0, 0.6):
        g.box((0.05, 0.25, 0.6), (x, -8.6, 0.45), 'hullDark', bevel=0, rot=(-0.45, 0, 0))
    g.box((2.4, 0.12, 0.08), (0, -8.72, -0.1), 'window', bevel=0)
    g.box((3.0, 0.4, 0.3), (0, -6.2, -1.05), 'hullDark', bevel=0.04)
    g.box((0.4, 2.2, 0.4), (0, -7.2, 1.35), 'hullDark', bevel=0.04)
    g.greeble(rng, (0, -6.8, 1.26), X, Y, Z, 2.0, 1.6, 12)
    for s in (-1, 1):
        g.box((0.06, 2.0, 0.12), (s * 1.46, -7.3, 0.4), 'hullDark', bevel=0)
        g.box((0.08, 0.5, 0.08), (s * 1.48, -6.5, -0.6), 'amber', bevel=0)
        g.cyl(0.18, 0.18, 0.3, (s * 1.55, -6.6, 0.9), 'hullDark', axis='x', seg=10)
        g.cyl(0.12, 0.12, 0.04, (s * 1.71, -6.6, 0.9), 'window', axis='x', seg=10, bevel=0)
    g.cyl(0.04, 0.04, 1.4, (0.7, -6.6, 1.9), 'hullDark', axis='z', seg=6, bevel=0)
    g.sphere(0.08, (0.7, -6.6, 2.62), 'red', seg=8, rings=6)
    g.sphere(0.5, (-0.6, -6.4, 1.55), 'hullLight', scale=(1, 1, 0.4), seg=16, rings=8)

    # spine truss
    y0, y1 = -6.0, 5.4
    for cx in (-0.45, 0.45):
        for cz in (-0.45, 0.45):
            g.seg((cx, y0, cz), (cx, y1, cz), 0.07, 'hullDark', 6)
    yy = y0
    i = 0
    while yy < y1 - 0.5:
        nxt = yy + 1.0
        for cx, cz, dx, dz in ((-0.45, -0.45, 0.9, 0), (-0.45, 0.45, 0.9, 0), (-0.45, -0.45, 0, 0.9), (0.45, -0.45, 0, 0.9)):
            a = (cx, yy if i % 2 else nxt, cz)
            b = (cx + dx, nxt if i % 2 else yy, cz + dz)
            g.seg(a, b, 0.035, 'hull', 5)
        yy = nxt
        i += 1

    paints = ['paintRed', 'paintBlue', 'paintOlive', 'paintTeal', 'paintWhite', 'accent']
    for i in range(4):
        y = -4.4 + i * 2.55
        for sx in (-1, 1):
            for sz in (-1, 1):
                if (i, sx, sz) == (3, 1, 1):
                    continue  # one empty slot: lived-in
                container(g, rng, (sx * 1.0, y, sz * 1.0), (1.7, 2.35, 1.7), rng.choice(paints))
        g.box((4.0, 0.18, 0.18), (0, y - 1.25, 0), 'hullDark', bevel=0.02)
        g.box((0.18, 0.18, 4.0), (0, y - 1.25, 0), 'hullDark', bevel=0.02)

    # engine block, radiators, tanks
    g.box((3.6, 2.0, 3.4), (0, 6.6, 0), 'hull', bevel=0.12)
    g.box((3.66, 0.16, 3.46), (0, 5.8, 0), 'yellow', bevel=0.02)
    g.greeble(rng, (0, 6.6, 1.7), X, Y, Z, 3.2, 1.7, 16)
    g.greeble(rng, (0, 6.6, -1.7), X, Y, -Z, 3.2, 1.7, 10)
    for sx in (-1, 1):
        g.sphere(0.85, (sx * 1.2, 5.0, 1.55), 'foil', seg=18, rings=10)
        for sz in (-1, 1):
            g.cyl(0.42, 0.68, 1.1, (sx * 0.85, 8.1, sz * 0.82), 'hullDark', seg=24)
            g.cyl(0.32, 0.42, 0.25, (sx * 0.85, 7.5, sz * 0.82), 'hullLight', seg=20)
            g.cyl(0.55, 0.55, 0.04, (sx * 0.85, 8.62, sz * 0.82), 'engine', seg=24, bevel=0)
        # radiator wings
        g.box((3.2, 2.2, 0.05), (sx * 3.6, 6.6, 0), 'hullLight', bevel=0.01)
        for k in range(8):
            g.box((0.03, 2.2, 0.08), (sx * (2.15 + k * 0.4), 6.6, 0), 'hullDark', bevel=0)
        g.box((3.2, 0.05, 0.1), (sx * 3.6, 5.5, 0), 'amber', bevel=0)
        g.box((1.1, 0.4, 0.3), (sx * 2.1, 6.6, 0), 'hullDark', bevel=0.03)
        g.sphere(0.07, (sx * 5.2, 6.6, 0.06), 'red' if sx < 0 else 'green', seg=8, rings=6)
    root = g.build()
    empty('anchor_nose', (0, -8.9, 0), root)
    for i, (sx, sz) in enumerate([(-1, -1), (1, -1), (-1, 1), (1, 1)]):
        empty(f'anchor_exhaust_{i}', (sx * 0.85, 8.7, sz * 0.82), root)
    return root


# ================================================================ SEED SHIP  (colony lander)
def build_seed():
    rng = random.Random(3)
    g = Group('seed')
    g.cyl(1.6, 1.6, 4.0, (0, -2.0, 0), 'hullLight', seg=32)
    g.sphere(1.6, (0, -4.0, 0), 'hullLight', scale=(1, 0.7, 1), seg=32, rings=16)
    for y in (-3.5, -0.4):
        g.torus(1.62, 0.07, (0, y, 0), 'accent', axis='y', seg=40, rseg=6)
    g.torus(1.61, 0.05, (0, -2.4, 0), 'window', axis='y', seg=40, rseg=4, sx=0.6)
    for k in range(4):
        a = k * math.pi / 2 + math.pi / 4
        n = Vector((math.cos(a), 0, math.sin(a)))
        u = Vector((-math.sin(a), 0, math.cos(a)))
        # folded solar wings
        g.obox((1.1, 3.4, 0.06), n * 1.72 + Vector((0, -2.0, 0)), u, Y, n, 'solar', bevel=0.01)
        g.obox((1.15, 0.06, 0.08), n * 1.76 + Vector((0, -3.7, 0)), u, Y, n, 'hullDark', bevel=0)
        # landing legs
        top = n * 1.5 + Vector((0, 0.8, 0))
        foot = n * 2.7 + Vector((0, 5.6, 0))
        g.seg(top, foot, 0.1, 'hullDark', 8)
        g.seg(n * 1.0 + Vector((0, 3.2, 0)), (top + foot) / 2, 0.06, 'hull', 6)
        g.cyl(0.45, 0.35, 0.12, tuple(foot + Vector((0, 0.05, 0))), 'hull', seg=16)
        b = k * math.pi / 2
        g.greeble(rng, Vector((math.cos(b), 0, math.sin(b))) * 1.62 + Vector((0, -1.0, 0)), Y, Vector((-math.sin(b), 0, math.cos(b))),
                  Vector((math.cos(b), 0, math.sin(b))), 1.2, 0.5, 4)
    # gold-foil propellant tanks
    for k in range(6):
        a = k * math.pi / 3
        g.sphere(0.62, (math.cos(a) * 1.15, 1.0, math.sin(a) * 1.15), 'foil', seg=18, rings=10)
    g.cyl(0.7, 0.7, 3.2, (0, 1.6, 0), 'hullDark', seg=20)
    g.cyl(1.65, 1.2, 0.4, (0, 0.1, 0), 'hull', seg=32)
    g.cyl(0.55, 1.35, 1.6, (0, 4.0, 0), 'hullDark', seg=28)
    g.torus(1.0, 0.06, (0, 3.6, 0), 'hullLight', axis='y', seg=28, rseg=5)
    g.cyl(1.25, 1.25, 0.04, (0, 4.79, 0), 'engine', seg=28, bevel=0)
    g.sphere(0.07, (0, -5.15, 0), 'red', seg=8, rings=6)
    root = g.build()
    empty('anchor_exhaust_0', (0, 4.9, 0), root)
    return root


# ================================================================ DRONE  (utility robot)
def build_drone():
    g = Group('drone')
    g.hexa(taper_pts(0.85, 1.05, 0.5, front=(0.7, 0.7), back=(0.9, 0.9)), 'hullLight', (0, 0, 0), bevel=0.06)
    g.hexa(taper_pts(0.6, 0.7, 0.1, front=(0.7, 1)), 'accent', (0, 0.05, 0.28), bevel=0.02)
    g.cyl(0.17, 0.17, 0.2, (0, -0.55, 0.02), 'hullDark', seg=16)
    g.sphere(0.1, (0, -0.64, 0.02), 'red', seg=12, rings=8)
    g.torus(0.15, 0.025, (0, -0.66, 0.02), 'hull', axis='y', seg=20, rseg=5)
    for sx in (-1, 1):
        for sy in (-1, 1):
            p = Vector((sx * 0.75, sy * 0.55, 0.05))
            g.seg((sx * 0.3, sy * 0.3, 0.05), p, 0.05, 'hullDark', 6)
            g.cyl(0.11, 0.13, 0.24, tuple(p), 'hull', axis='z', seg=14)
            g.cyl(0.08, 0.08, 0.02, tuple(p - Vector((0, 0, 0.13))), 'engine', axis='z', seg=14, bevel=0)
            g.box((0.02, 0.1, 0.03), tuple(p + Vector((sx * 0.13, 0, 0.05))), 'amber', bevel=0)
        # manipulators
        a, b, c = Vector((sx * 0.2, -0.3, -0.22)), Vector((sx * 0.25, -0.55, -0.5)), Vector((sx * 0.15, -0.85, -0.45))
        g.seg(a, b, 0.04, 'hullDark', 6)
        g.seg(b, c, 0.035, 'hull', 6)
        g.sphere(0.055, tuple(b), 'hullDark', seg=8, rings=6)
        g.box((0.03, 0.14, 0.03), tuple(c + Vector((sx * 0.03, -0.06, 0.03))), 'hullDark', bevel=0)
        g.box((0.03, 0.14, 0.03), tuple(c + Vector((sx * 0.03, -0.06, -0.03))), 'hullDark', bevel=0)
    g.cyl(0.012, 0.012, 0.45, (0.18, 0.35, 0.5), 'hullDark', axis='z', seg=6, bevel=0)
    g.sphere(0.03, (0.18, 0.35, 0.73), 'amber', seg=6, rings=4)
    return g.build()


# ================================================================ MECH  (industrial loader frame)
def build_mech():
    rng = random.Random(5)
    root = empty('mech', (0, 0, 0))

    p = Group('pelvis')
    p.box((1.5, 0.95, 0.62), (0, 0, 3.0), 'hull', bevel=0.07)
    p.cyl(0.32, 0.32, 2.05, (0, 0, 3.0), 'hullDark', axis='x', seg=18)
    p.hexa(taper_pts(1.0, 0.16, 0.55, front=(1, 1), back=(0.8, 1)), 'accent', (0, -0.55, 2.82), bevel=0.03)
    p.hexa(taper_pts(1.2, 0.2, 0.5), 'hullDark', (0, 0.55, 2.85), bevel=0.03)
    pelvis = p.build((0, 0, 3.0), root)

    for s, side in ((-1, 'L'), (1, 'R')):
        x = 0.74 * s
        t = Group(f'thigh_{side}')
        t.cyl(0.36, 0.36, 0.4, (x, 0, 3.0), 'hullDark', axis='x', seg=18)
        t.hexa(taper_pts(0.66, 0.85, 1.3, front=(0.95, 1)), 'hullLight', (x, 0.02, 2.36), bevel=0.07)
        t.hexa(taper_pts(0.55, 0.2, 1.05, front=(0.8, 0.9)), 'hull', (x, -0.5, 2.42), bevel=0.04)
        t.box((0.04, 0.5, 0.06), (x + s * 0.34, 0, 2.5), 'amber', bevel=0)
        t.seg((x + s * 0.12, 0.45, 2.85), (x + s * 0.12, 0.45, 1.9), 0.07, 'hullDark', 10)
        t.seg((x + s * 0.12, 0.45, 2.3), (x + s * 0.12, 0.45, 1.8), 0.045, 'hullLight', 8)
        thigh = t.build((x, 0, 3.0), pelvis)

        k = Group(f'shin_{side}')
        k.sphere(0.32, (x, 0, 1.72), 'hullDark', seg=18, rings=10)
        k.hexa(([(x - 0.36, -0.5, 0.42), (x + 0.36, -0.5, 0.42), (x + 0.32, 0.45, 0.42), (x - 0.32, 0.45, 0.42)],
                [(x - 0.32, -0.58, 1.62), (x + 0.32, -0.58, 1.62), (x + 0.28, 0.32, 1.62), (x - 0.28, 0.32, 1.62)]), 'hull', bevel=0.07)
        k.hexa(taper_pts(0.5, 0.18, 0.95, front=(0.8, 0.95)), 'accent', (x, -0.62, 1.15), bevel=0.04)
        k.hexa(taper_pts(0.48, 0.24, 0.42, front=(0.7, 0.7)), 'hullLight', (x, -0.6, 1.76), bevel=0.05)
        k.box((0.18, 0.05, 0.09), (x, -0.73, 0.75), 'amber', bevel=0)
        k.seg((x, 0.52, 1.55), (x, 0.52, 0.55), 0.075, 'hullDark', 10)
        k.seg((x, 0.52, 1.0), (x, 0.52, 0.4), 0.05, 'hullLight', 8)
        k.greeble(rng, (x + s * 0.34, 0, 1.0), Y, Z, Vector((s, 0, 0)), 0.6, 0.9, 4)
        shin = k.build((x, 0, 1.72), thigh)

        f = Group(f'foot_{side}')
        f.hexa(taper_pts(0.9, 1.4, 0.32, front=(0.9, 0.6), fz=-0.04), 'hullDark', (x, -0.2, 0.17), bevel=0.05)
        for dx in (-0.24, 0.24):
            f.hexa(taper_pts(0.32, 0.55, 0.22, front=(0.7, 0.5), fz=-0.04), 'hull', (x + dx, -1.05, 0.12), bevel=0.03)
        f.hexa(taper_pts(0.4, 0.5, 0.2, back=(0.6, 0.5)), 'hull', (x, 0.7, 0.12), bevel=0.03)
        f.box((0.75, 0.3, 0.06), (x, -0.55, 0.36), 'accent', bevel=0.02)
        f.cyl(0.22, 0.22, 0.55, (x, 0.05, 0.38), 'hullDark', axis='x', seg=14)
        f.build((x, 0.05, 0.38), shin)

    tr = Group('torso')
    tr.cyl(0.46, 0.52, 0.5, (0, 0, 3.42), 'hullDark', axis='z', seg=18)
    tr.hexa(([(-0.85, -0.6, 3.6), (0.85, -0.6, 3.6), (0.85, 0.65, 3.6), (-0.85, 0.65, 3.6)],
             [(-1.25, -0.85, 4.95), (1.25, -0.85, 4.95), (1.25, 0.8, 4.95), (-1.25, 0.8, 4.95)]), 'hullLight', bevel=0.09)
    # cockpit: wide canopy with frame
    tr.hexa(([(-0.7, -0.9, 4.05), (0.7, -0.9, 4.05), (0.7, -0.75, 4.05), (-0.7, -0.75, 4.05)],
             [(-0.78, -1.02, 4.75), (0.78, -1.02, 4.75), (0.78, -0.85, 4.75), (-0.78, -0.85, 4.75)]), 'glass', bevel=0.02)
    for xx in (-0.4, 0.0, 0.4):
        tr.box((0.05, 0.12, 0.72), (xx, -0.98, 4.4), 'hullDark', bevel=0, rot=(0.17, 0, 0))
    tr.box((1.7, 0.2, 0.12), (0, -0.98, 4.85), 'hull', bevel=0.02)
    tr.box((1.6, 0.2, 0.14), (0, -0.88, 3.95), 'accent', bevel=0.02)
    for sx in (-1, 1):
        tr.cyl(0.1, 0.12, 0.14, (sx * 0.95, -0.92, 4.85), 'hullDark', seg=12)
        tr.cyl(0.08, 0.08, 0.02, (sx * 0.95, -1.0, 4.85), 'window', seg=12, bevel=0)
        tr.hexa(taper_pts(0.3, 1.4, 1.1), 'hull', (sx * 1.2, 0, 4.2), bevel=0.05)
    # backpack, jets, exhaust vents
    tr.box((1.55, 0.7, 1.35), (0, 1.05, 4.3), 'hullDark', bevel=0.07)
    tr.box((1.6, 0.06, 0.12), (0, 1.42, 4.8), 'accent', bevel=0)
    tr.greeble(rng, (0, 1.4, 4.2), X, Z, Y, 1.3, 0.9, 10)
    for sx in (-1, 1):
        tr.cyl(0.22, 0.32, 0.5, (sx * 0.42, 1.05, 3.48), 'hull', axis='z', seg=16)
        tr.cyl(0.25, 0.25, 0.03, (sx * 0.42, 1.05, 3.24), 'engineHot', axis='z', seg=16, bevel=0)
        for k in range(4):
            tr.box((0.5, 0.05, 0.04), (sx * 0.45, 1.42, 4.0 + k * 0.12), 'hullDark', bevel=0)
    tr.cyl(0.02, 0.02, 0.9, (0.55, 0.9, 5.4), 'hullDark', axis='z', seg=6, bevel=0)
    tr.sphere(0.04, (0.55, 0.9, 5.86), 'red', seg=8, rings=6)
    torso = tr.build((0, 0, 3.3), pelvis)

    h = Group('head')
    h.hexa(taper_pts(0.7, 0.8, 0.42, front=(0.85, 0.7)), 'hull', (0, -0.05, 5.17), bevel=0.05)
    h.box((0.55, 0.05, 0.09), (0, -0.46, 5.2), 'amber', bevel=0)
    h.cyl(0.11, 0.11, 0.3, (0.3, -0.3, 5.42), 'hullDark', seg=12)
    h.cyl(0.08, 0.08, 0.02, (0.3, -0.46, 5.42), 'window', seg=12, bevel=0)
    h.build((0, 0, 4.95), torso)

    for s, side in ((-1, 'L'), (1, 'R')):
        x = 1.68 * s
        a = Group(f'arm_{side}')
        # shoulder pauldron
        a.hexa(([(x - 0.5, -0.65, 4.35), (x + 0.5, -0.65, 4.35), (x + 0.5, 0.65, 4.35), (x - 0.5, 0.65, 4.35)],
                [(x - 0.42 + 0.1 * s, -0.52, 5.15), (x + 0.42 + 0.1 * s, -0.52, 5.15), (x + 0.42 + 0.1 * s, 0.52, 5.15), (x - 0.42 + 0.1 * s, 0.52, 5.15)]), 'accent', bevel=0.07)
        a.box((1.02, 1.32, 0.08), (x, 0, 4.42), 'hullDark', bevel=0.02)
        a.box((0.06, 0.8, 0.3), (x + s * 0.5, 0, 4.75), 'hullLight', bevel=0.01)
        a.box((0.46, 0.46, 1.0), (x, 0, 3.95), 'hullLight', bevel=0.05)
        a.seg((x, 0.3, 4.3), (x, 0.3, 3.2), 0.06, 'hullDark', 8)
        a.cyl(0.24, 0.24, 0.62, (x, 0, 3.42), 'hullDark', axis='x', seg=16)
        a.box((0.62, 0.66, 1.2), (x, -0.08, 2.86), 'hull', bevel=0.07)
        a.box((0.66, 0.4, 0.1), (x, -0.3, 3.3), 'accent', bevel=0.02)
        a.box((0.04, 0.4, 0.08), (x + 0.32 * s, -0.08, 3.1), 'amber', bevel=0)
        if s > 0:  # hydraulic claw
            a.cyl(0.2, 0.2, 0.5, (x, -0.6, 2.55), 'hullDark', seg=16)
            for dz in (-0.18, 0.18):
                a.hexa(taper_pts(0.12, 0.9, 0.12, front=(0.6, 0.6)), 'hullLight', (x, -1.15, 2.55 + dz), bevel=0.02, rot=(dz * 1.5, 0, 0))
            a.cyl(0.05, 0.05, 0.1, (x, -0.88, 2.55), 'window', seg=8, bevel=0)
        else:  # mining drill
            a.cyl(0.3, 0.3, 0.35, (x, -0.55, 2.55), 'hullDark', seg=18)
            a.torus(0.31, 0.04, (x, -0.72, 2.55), 'amber', axis='y', seg=20, rseg=5)
            a.cyl(0.02, 0.3, 0.95, (x, -1.2, 2.55), 'hullLight', seg=14, bevel=0.01)
            for k in range(3):
                a.torus(0.26 - k * 0.07, 0.025, (x, -0.85 - k * 0.22, 2.55), 'hullDark', axis='y', seg=16, rseg=4)
        a.build((x * 0.92, 0, 4.6), torso)
    return root


# ================================================================ STATION CORE  (Eden)
def build_station():
    rng = random.Random(21)
    g = Group('station', uvscale=0.5)
    g.cyl(1.6, 1.6, 12, (0, 0, 0), 'hull', axis='z', seg=24)
    for z in (-5.4, -3.2, 3.2, 5.4):
        g.cyl(1.75, 1.75, 0.35, (0, 0, z), 'hullLight', axis='z', seg=24)
    g.cyl(2.5, 2.5, 3.0, (0, 0, 0), 'hullLight', axis='z', seg=32)
    g.torus(2.51, 0.06, (0, 0, 0.6), 'window', seg=40, rseg=4, sx=0.5)
    g.torus(2.51, 0.06, (0, 0, -0.6), 'window', seg=40, rseg=4, sx=0.5)
    g.cyl(2.55, 2.55, 0.2, (0, 0, 1.45), 'accent', axis='z', seg=32)
    g.cyl(1.1, 1.6, 1.0, (0, 0, 6.5), 'hullLight', axis='z', seg=20)
    g.cyl(1.1, 1.6, 1.0, (0, 0, -6.5), 'hullLight', axis='z', seg=20)
    g.cyl(0.1, 0.1, 6, (0, 0, 9.5), 'hullDark', axis='z', seg=6, bevel=0)
    for k in range(4):
        a = k * math.pi / 2
        n = Vector((math.cos(a), math.sin(a), 0))
        u = Vector((-math.sin(a), math.cos(a), 0))
        g.greeble(rng, n * 1.6 + Vector((0, 0, 3.8)), u, Z, n, 1.4, 2.6, 8)
        g.greeble(rng, n * 1.6 + Vector((0, 0, -3.8)), u, Z, n, 1.4, 2.6, 8)
    # docking ports
    for s in (-1, 1):
        g.cyl(0.6, 0.6, 1.6, (s * 3.2, 0, -4.2), 'hullLight', axis='x', seg=16)
        g.cyl(0.75, 0.75, 0.2, (s * 4.0, 0, -4.2), 'hullDark', axis='x', seg=16)
        g.torus(0.6, 0.04, (s * 4.12, 0, -4.2), 'amber', axis='x', seg=20, rseg=4)
    root = g.build()

    r = Group('ring', uvscale=0.5)
    R, n = 7.0, 36
    for i in range(n):
        a = 2 * math.pi * (i + 0.5) / n
        c = Vector((math.cos(a) * R, math.sin(a) * R, 0))
        u = Vector((-math.sin(a), math.cos(a), 0))
        nrm = Vector((math.cos(a), math.sin(a), 0))
        L = 2 * math.pi * R / n + 0.06
        r.obox((L, 1.8, 1.5), c, u, Z, nrm, 'hullLight', bevel=0.05)
        r.obox((L * 0.9, 0.18, 0.04), c + nrm * 0.76, u, Z, nrm, 'window', bevel=0)
        r.obox((L * 0.9, 0.1, 0.04), c - nrm * 0.76 + Vector((0, 0, 0.35)), u, Z, -nrm, 'window', bevel=0)
        r.obox((L, 0.12, 1.54), c + Vector((0, 0, 0.92)), u, Z, nrm, 'accent' if i % 6 == 0 else 'hull', bevel=0.01)
        if i % 3 == 0:
            r.obox((0.5, 0.5, 0.3), c + nrm * 0.9 + Vector((0, 0, -0.5)), u, Z, nrm, 'hullDark', bevel=0.02)
    for k in range(4):
        a = k * math.pi / 2
        d = Vector((math.cos(a), math.sin(a), 0))
        r.seg(d * 2.5, d * 6.2, 0.28, 'hullDark', 10)
        r.seg(d * 2.5 + Vector((0, 0, 0.5)), d * 6.2 + Vector((0, 0, 0.5)), 0.1, 'hull', 6)
        r.cyl(0.45, 0.45, 0.6, tuple(d * 4.3), 'hull', axis='x', seg=12, rot=(0, 0, a))
    r.build((0, 0, 0), root)
    return root


# ================================================================ ORBITAL JUNK  (salvage field)
def build_junk():
    rng = random.Random(9)
    # dead comsat: foil bus, bent wings, dish
    g = Group('junk_sat')
    g.box((1.2, 1.2, 1.5), (0, 0, 0), 'foil', bevel=0.04)
    g.box((1.25, 1.25, 0.1), (0, 0, 0.7), 'hullLight', bevel=0.01)
    g.seg((0.6, 0, 0.1), (1.0, 0, 0.1), 0.04, 'hullDark')
    g.obox((3.0, 1.1, 0.05), (2.5, 0, 0.35), Vector((1, 0, 0.25)), Y, Vector((-0.25, 0, 1)), 'solar', bevel=0.01)
    g.seg((-0.6, 0, 0.1), (-1.0, 0, 0.1), 0.04, 'hullDark')
    g.obox((3.0, 1.1, 0.05), (-2.4, 0.2, -0.3), Vector((1, 0.15, -0.3)), Y, Vector((0.3, 0, 1)), 'solar', bevel=0.01)
    g.cyl(0.9, 0.2, 0.35, (0, -0.85, 0.3), 'hullLight', seg=20, rot=(0.3, 0, 0))
    g.cyl(0.03, 0.03, 0.6, (0, -1.0, 0.3), 'hullDark', seg=6, bevel=0)
    g.greeble(rng, (0, 0, 0.75), X, Y, Z, 1.0, 1.0, 6)
    g.build((0, 0, 0))
    # spent upper stage
    g = Group('junk_stage')
    g.cyl(1.2, 1.2, 5.0, (0, 0, 0), 'paintWhite', seg=24)
    g.cyl(1.22, 1.22, 0.3, (0, -1.6, 0), 'hullDark', seg=24)
    g.cyl(1.22, 1.22, 0.3, (0, 1.6, 0), 'hullDark', seg=24)
    g.cyl(1.2, 0.5, 0.8, (0, 2.9, 0), 'hull', seg=20)
    g.cyl(0.35, 0.9, 1.3, (0, 3.9, 0), 'hullDark', seg=20)
    g.cyl(1.0, 1.0, 0.5, (0, -2.75, 0), 'hull', seg=24)
    g.box((0.1, 3.0, 0.4), (1.2, 0, 0), 'accent', bevel=0.01)
    g.build((0, 0, 0))
    # torn solar panel
    g = Group('junk_panel')
    g.box((3.2, 1.4, 0.05), (0, 0, 0), 'solar', bevel=0.01)
    g.box((3.3, 0.06, 0.08), (0, 0.7, 0), 'hullLight', bevel=0)
    g.box((3.3, 0.06, 0.08), (0, -0.7, 0), 'hullLight', bevel=0)
    g.box((1.4, 1.4, 0.05), (2.1, 0.3, 0.3), 'solar', bevel=0.01, rot=(0.2, -0.5, 0.2))
    g.seg((-1.6, 0, 0), (-2.4, 0, 0), 0.05, 'hullDark')
    g.build((0, 0, 0))
    # small sat bus in gold foil with antenna stubs
    g = Group('junk_bus')
    g.box((0.9, 0.9, 0.9), (0, 0, 0), 'foil', bevel=0.03)
    g.cyl(0.25, 0.25, 0.3, (0, 0, 0.6), 'hullLight', axis='z', seg=14)
    for k in range(3):
        a = k * 2.1
        g.seg((0, 0, 0.4), (math.cos(a) * 1.0, math.sin(a) * 1.0, 0.9), 0.015, 'hullDark', 5)
    g.box((0.92, 0.92, 0.12), (0, 0, -0.5), 'hullDark', bevel=0.01)
    g.build((0, 0, 0))
    # ruptured propellant tank
    g = Group('junk_tank')
    g.sphere(0.9, (0, 0, 0), 'hullLight', scale=(1, 1.4, 1), seg=20, rings=12)
    g.torus(0.92, 0.05, (0, 0, 0), 'hullDark', axis='y', seg=24, rseg=4)
    g.seg((0, 1.2, 0), (0, 1.9, 0.2), 0.08, 'hull')
    g.build((0, 0, 0))


# ---------------------------------------------------------------- export + preview
def export(name):
    path = os.path.join(OUT, f'{name}.glb')
    bpy.ops.export_scene.gltf(filepath=path, export_format='GLB', export_yup=True, export_draco_mesh_compression_enable=True, export_draco_mesh_compression_level=7)
    print(f'EXPORTED {path} ({os.path.getsize(path) // 1024} KB)')


def preview(name):
    if not PREVIEW:
        return
    sc = bpy.context.scene
    objs = [o for o in sc.objects if o.type == 'MESH']
    pts = [o.matrix_world @ Vector(c) for o in objs for c in o.bound_box]
    lo = Vector((min(p.x for p in pts), min(p.y for p in pts), min(p.z for p in pts)))
    hi = Vector((max(p.x for p in pts), max(p.y for p in pts), max(p.z for p in pts)))
    centre, radius = (lo + hi) / 2, (hi - lo).length / 2
    cam_data = bpy.data.cameras.new('cam')
    cam_data.lens = 50
    cam = bpy.data.objects.new('cam', cam_data)
    sc.collection.objects.link(cam)
    sc.camera = cam
    sc.render.engine = 'BLENDER_WORKBENCH'
    sh = sc.display.shading
    sh.light = 'STUDIO'
    sh.color_type = 'MATERIAL'
    sh.show_specular_highlight = True
    sh.show_cavity = True
    sh.show_shadows = True
    sc.render.resolution_x, sc.render.resolution_y = 900, 600
    sc.render.film_transparent = False
    for i, d in enumerate([Vector((1.0, -1.3, 0.7)), Vector((-1.1, 1.0, 0.55))]):
        cam.location = centre + d.normalized() * radius * 2.4
        cam.rotation_euler = (centre - cam.location).to_track_quat('-Z', 'Y').to_euler()
        bpy.context.view_layer.update()
        sc.render.filepath = os.path.join(PREVIEW, f'{name}_{i}.png')
        bpy.ops.render.render(write_still=True)
    bpy.data.objects.remove(cam)


BUILDERS = {'skiff': build_skiff, 'hauler': build_hauler, 'seed': build_seed, 'drone': build_drone, 'mech': build_mech,
            'station': build_station, 'junk': build_junk}
only = [a for a in argv[2:]] or list(BUILDERS)
for name in only:
    reset()
    BUILDERS[name]()
    export(name)
    preview(name)
print('DONE')
