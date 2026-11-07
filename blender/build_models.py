"""Builds The Open Space hero models and exports GLBs.

Run:  blender --background --factory-startup --python blender/build_models.py -- public/models [preview_dir] [names...]

Some ships are third-party CC-BY models (see public/models/CREDITS.txt) imported from the
originals kept outside the repo in ../game-assets/ships/<name>/original.glb (override the
folder with the TOS_ASSETS env var). They are re-oriented, scaled, given the game's anchors
and engine/nav-light bits, and re-exported with WebP textures + Draco. Without the originals
each builder falls back to its procedural model.

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
ASSETS = os.environ.get('TOS_ASSETS') or os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', '..', 'game-assets', 'ships'))

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
    'pearl':      ((0.78, 0.8, 0.82), 0.3, 0.28, None, 0),
    'candy':      ((0.01, 0.05, 0.2), 0.6, 0.25, None, 0),
    'carbon':     ((0.015, 0.016, 0.02), 0.3, 0.3, None, 0),
    'chrome':     ((0.8, 0.8, 0.82), 1.0, 0.1, None, 0),
    'visor':      ((0.9, 0.62, 0.2), 1.0, 0.06, None, 0),
    'lamp':       ((0, 0, 0), 0, 0.5, (1.0, 0.95, 0.85), 4.0),
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
        if m.determinant() < 0:  # mirrored basis: faces came out inside-out
            bmesh.ops.reverse_faces(pbm, faces=pbm.faces)
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


# ---------------------------------------------------------------- third-party models
def _bbox(objs):
    pts = [o.matrix_world @ Vector(c) for o in objs for c in o.bound_box]
    lo = Vector((min(p.x for p in pts), min(p.y for p in pts), min(p.z for p in pts)))
    hi = Vector((max(p.x for p in pts), max(p.y for p in pts), max(p.z for p in pts)))
    return lo, hi


def vendor(name, sub, size, axis=1, rot=(0, 0, 0), ratio=None, tex=1024, rename=None):
    """Import ../game-assets/ships/<sub>/original.glb as one mesh object `name`: world transforms baked,
    rotated by `rot` (radians, applied first), centred on its bounding box and scaled so its extent
    along `axis` (0 x, 1 y, 2 z) is `size` metres. ratio < 1 decimates; images are capped at `tex` px.
    rename maps imported material names to new ones (e.g. onto the game's PBR names). None if missing."""
    path = os.path.join(ASSETS, sub, 'original.glb')
    if not os.path.exists(path):
        print(f'NOTE {path} missing: using the procedural {name}')
        return None
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=path)
    new = [o for o in bpy.data.objects if o not in before]
    bpy.context.view_layer.update()
    meshes = [o for o in new if o.type == 'MESH']
    R = Euler(rot).to_matrix().to_4x4()
    for o in meshes:
        mw = o.matrix_world.copy()
        o.parent = None
        o.data = o.data.copy()
        o.data.transform(R @ mw)
        o.matrix_world = Matrix.Identity(4)
    for o in new:
        if o.type != 'MESH':
            bpy.data.objects.remove(o)
    with bpy.context.temp_override(active_object=meshes[0], selected_editable_objects=meshes, selected_objects=meshes, object=meshes[0]):
        bpy.ops.object.join()
    obj = meshes[0]
    obj.name = obj.data.name = name
    bpy.context.view_layer.update()
    lo, hi = _bbox([obj])
    k = size / (hi - lo)[axis]
    obj.data.transform(Matrix.Scale(k, 4) @ Matrix.Translation(-(lo + hi) / 2))
    if ratio:
        mod = obj.modifiers.new('dec', 'DECIMATE')
        mod.ratio = ratio
        mod.use_collapse_triangulate = True
        with bpy.context.temp_override(object=obj, active_object=obj):
            bpy.ops.object.modifier_apply(modifier=mod.name)
    for m in obj.data.materials:
        if m and rename and m.name in rename:
            m.name = rename[m.name]
    for img in bpy.data.images:
        if img.size[0] > tex or img.size[1] > tex:
            img.scale(min(tex, img.size[0]), min(tex, img.size[1]))
    bpy.context.view_layer.update()
    lo, hi = _bbox([obj])
    print(f'VENDOR {name}: {len(obj.data.polygons)} faces, size {tuple(round(v, 2) for v in hi - lo)}')
    return obj


def mat_bounds(obj):
    """Debug: per-material bounding boxes of a mesh (to place anchors on imported models)."""
    me = obj.data
    for i, m in enumerate(me.materials):
        vs = {v for p in me.polygons if p.material_index == i for v in p.vertices}
        if not vs:
            continue
        cs = [me.vertices[v].co for v in vs]
        lo = Vector((min(c.x for c in cs), min(c.y for c in cs), min(c.z for c in cs)))
        hi = Vector((max(c.x for c in cs), max(c.y for c in cs), max(c.z for c in cs)))
        print(f'  MATBOX {m.name}: lo {tuple(round(v, 2) for v in lo)} hi {tuple(round(v, 2) for v in hi)}')


def attach(obj, g):
    """Merge a procedural Group's mesh into an imported object (keeps both material sets)."""
    part = g.build()
    with bpy.context.temp_override(active_object=obj, selected_editable_objects=[obj, part], selected_objects=[obj, part], object=obj):
        bpy.ops.object.join()
    return obj


def loft(g, secs, mat, smooth=False):
    """Faceted hull lofted through cross-sections. secs: (y, w, zt, zb, ws, zc) = station, chine half
    width, top and keel heights, shoulder half width, chine height. Each ring is an octagon."""
    bm = bmesh.new()
    rings = []
    for y, w, zt, zb, ws, zc in secs:
        pts = [(0, zt), (ws, zt - (zt - zc) * 0.25), (w, zc), (ws * 0.75, zb + (zc - zb) * 0.3), (0, zb),
               (-ws * 0.75, zb + (zc - zb) * 0.3), (-w, zc), (-ws, zt - (zt - zc) * 0.25)]
        rings.append([bm.verts.new((x, y, z)) for x, z in pts])
    for a, b in zip(rings, rings[1:]):
        for k in range(8):
            bm.faces.new((a[k], a[(k + 1) % 8], b[(k + 1) % 8], b[k]))
    bm.faces.new(rings[0])
    bm.faces.new(rings[-1][::-1])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return g.add(bm, mat, bevel=0, smooth=smooth)


# ================================================================ SKIFF  (Kestrel Mk II strike cutter, the player's ship)
def build_skiff_proc():
    """Kestrel Mk II: an ~9 m arrowhead cutter. Faceted gunmetal hull under layered pearl armour panels
    with shut-line gaps, a raised tinted canopy in a cowl, swept wings and forward canards, twin armoured
    nacelles with ringed intakes and canted tail fins, amber light strips along the chines and a nose
    chevron, a rear light bar, window rows, belly mining laser. Forward = -Y."""
    rng = random.Random(7)
    g = Group('skiff')
    HULL = [(-4.6, 0.05, 0.03, -0.03, 0.03, 0.0), (-4.0, 0.36, 0.2, -0.13, 0.22, 0.0), (-3.0, 0.7, 0.42, -0.25, 0.42, -0.02),
            (-1.8, 0.95, 0.62, -0.35, 0.56, -0.05), (-0.4, 1.12, 0.72, -0.42, 0.66, -0.06), (1.2, 1.18, 0.7, -0.45, 0.7, -0.06),
            (2.8, 1.04, 0.6, -0.42, 0.64, -0.06), (3.8, 0.78, 0.45, -0.34, 0.5, -0.06)]
    loft(g, HULL, 'hull')
    # keel in gloss carbon
    loft(g, [(y, w * 0.7, zb + 0.06, zb - 0.06, ws * 0.6, zb) for y, w, zt, zb, ws, zc in HULL[1:-1]], 'carbon')

    def at(y, i):
        """Interpolate a hull section column at station y."""
        for a, b in zip(HULL, HULL[1:]):
            if a[0] <= y <= b[0]:
                k = (y - a[0]) / (b[0] - a[0])
                return a[i] + (b[i] - a[i]) * k
        return HULL[-1][i]

    # layered dorsal armour: pearl panels with shut-line gaps, stepping up along the spine
    for y0, y1, lift in ((-3.7, -2.95, 0.02), (-0.5, 0.75, 0.05), (0.85, 2.05, 0.07), (2.15, 3.3, 0.05)):
        ym = (y0 + y1) / 2
        w0, w1 = at(y0, 4) * 0.92, at(y1, 4) * 0.92
        z0, z1 = at(y0, 2), at(y1, 2)
        g.hexa(([(-w0, y0, z0 - 0.05), (w0, y0, z0 - 0.05), (w1, y1, z1 - 0.05), (-w1, y1, z1 - 0.05)],
                [(-w0 * 0.55, y0, z0 + lift), (w0 * 0.55, y0, z0 + lift), (w1 * 0.55, y1, z1 + lift), (-w1 * 0.55, y1, z1 + lift)]), 'pearl', bevel=0.02)
    for s in (-1, 1):
        # side armour plates along the chine, split in three
        for y0, y1 in ((-2.9, -1.3), (-1.2, 0.9), (1.0, 2.9)):
            p0 = Vector((s * at(y0, 1), y0, at(y0, 5))); p1 = Vector((s * at(y1, 1), y1, at(y1, 5)))
            q0 = Vector((s * at(y0, 4), y0, at(y0, 2) - (at(y0, 2) - at(y0, 5)) * 0.25)); q1 = Vector((s * at(y1, 4), y1, at(y1, 2) - (at(y1, 2) - at(y1, 5)) * 0.25))
            n0 = Vector((s * 0.03, 0, 0.03))
            g.hexa(([p0 + n0 * 0.2, p1 + n0 * 0.2, q1 + n0 * 0.2, q0 + n0 * 0.2], [p0 + n0 * 1.6, p1 + n0 * 1.6, q1 + n0 * 1.6, q0 + n0 * 1.6]), 'pearl', bevel=0.01)
        # amber light strip along the chine, nose to tail
        pts = [Vector((s * (at(y, 1) + 0.025), y, at(y, 5))) for y in (-3.6, -3.0, -1.8, -0.4, 1.2, 2.8, 3.5)]
        for a, b in zip(pts, pts[1:]):
            g.seg(tuple(a), tuple(b), 0.022, 'amber', 6)
        # window row under the chine
        for k in range(7):
            y = -1.4 + k * 0.42
            g.box((0.02, 0.2, 0.07), (s * (at(y, 1) * 0.93), y, at(y, 5) - 0.16), 'window', bevel=0, rot=(0, s * 0.35, 0))
        # nose chevron light
        g.seg((s * 0.04, -4.3, 0.12), (s * 0.4, -3.4, 0.33), 0.02, 'amber', 6)
        # forward strakes: thin, sharply swept, flush with the chine (no upturned canard tips)
        g.add(slab((s * 0.6, -2.7, -0.03), (s * 0.85, -1.1, -0.04), (s * 1.3, -0.85, -0.06), (s * 1.32, -0.6, -0.06), 0.05, 0.015), 'pearl', bevel=0.006)
        g.seg((s * 0.63, -2.65, -0.01), (s * 1.3, -0.86, -0.04), 0.012, 'amber', 6)
        # swept main wing: gunmetal spar, pearl upper plate, amber leading-edge light, tip pod
        g.add(slab((s * 0.95, -0.3, -0.12), (s * 0.95, 2.7, -0.12), (s * 4.0, 2.3, -0.32), (s * 4.25, 3.35, -0.32), 0.2, 0.07), 'hull', bevel=0.02)
        g.add(slab((s * 1.2, 0.2, -0.0), (s * 1.2, 2.3, -0.0), (s * 3.3, 2.15, -0.2), (s * 3.45, 2.95, -0.2), 0.03, 0.02), 'pearl', bevel=0.008)
        g.add(slab((s * 1.25, 2.35, -0.02), (s * 1.25, 2.62, -0.02), (s * 3.5, 3.0, -0.22), (s * 3.55, 3.2, -0.22), 0.02, 0.02), 'candy', bevel=0.004)
        g.seg((s * 1.0, -0.25, -0.1), (s * 4.0, 2.3, -0.3), 0.025, 'amber', 6)
        g.cyl(0.09, 0.09, 1.3, (s * 4.15, 2.75, -0.32), 'hullDark', seg=12)
        g.sphere(0.06, (s * 4.15, 2.05, -0.32), 'red' if s < 0 else 'green', seg=10, rings=6)
        g.greeble(rng, (s * 2.2, 1.6, -0.06), Y, X, Z, 1.0, 0.6, 5, hmax=0.04)
        # armoured engine nacelle on a pylon
        nx = s * 1.5
        g.box((0.5, 2.2, 0.28), (s * 1.15, 2.3, -0.05), 'hullDark', bevel=0.04)
        g.cyl(0.44, 0.44, 3.4, (nx, 2.5, -0.05), 'hull', seg=28)
        g.cyl(0.34, 0.44, 0.3, (nx, 0.65, -0.05), 'hullLight', seg=28)
        g.cyl(0.3, 0.3, 0.05, (nx, 0.52, -0.05), 'hullDark', seg=24, bevel=0)
        g.torus(0.4, 0.04, (nx, 0.7, -0.05), 'chrome', axis='y', seg=32, rseg=6)
        for y in (1.4, 2.3, 3.2):
            g.torus(0.445, 0.025, (nx, y, -0.05), 'hullDark', axis='y', seg=28, rseg=5)
        g.hexa(taper_pts(0.62, 2.8, 0.18, front=(0.6, 0.6)), 'pearl', (nx, 2.4, 0.38), bevel=0.03)
        g.box((0.05, 1.8, 0.05), (nx + s * 0.44, 2.4, 0.05), 'amber', bevel=0)
        g.cyl(0.46, 0.4, 0.45, (nx, 4.42, -0.05), 'hullDark', seg=28)
        g.cyl(0.36, 0.36, 0.04, (nx, 4.65, -0.05), 'engine', seg=28, bevel=0)
        g.torus(0.42, 0.035, (nx, 4.6, -0.05), 'engineHot', axis='y', seg=32, rseg=6)
        # canted tail fin
        g.hexa(([(nx - 0.04, 2.9, 0.4), (nx + 0.04, 2.9, 0.4), (nx + 0.04, 4.1, 0.4), (nx - 0.04, 4.1, 0.4)],
                [(nx + s * 0.5 - 0.02, 3.75, 1.35), (nx + s * 0.5 + 0.02, 3.75, 1.35), (nx + s * 0.5 + 0.02, 4.3, 1.35), (nx + s * 0.5 - 0.02, 4.3, 1.35)]), 'hull', bevel=0.012)
        g.seg((nx + s * 0.03, 2.95, 0.45), (nx + s * 0.5, 3.77, 1.36), 0.015, 'amber', 6)
    # canopy: a low teardrop fairing lofted out of the nose and back into the spine, with a
    # tinted glass blister that follows its curve (no bolted-on bubble or frame rails)
    FAIR = [(-3.7, 0.06, 0.3, 0.18, 0.05, 0.26), (-3.1, 0.26, 0.55, 0.3, 0.22, 0.44), (-2.3, 0.4, 0.76, 0.44, 0.35, 0.6),
            (-1.4, 0.43, 0.81, 0.54, 0.38, 0.67), (-0.4, 0.34, 0.8, 0.62, 0.3, 0.71), (0.7, 0.14, 0.76, 0.66, 0.12, 0.72)]
    loft(g, FAIR, 'pearl', smooth=True)

    def fair_at(y):
        for a, b in zip(FAIR, FAIR[1:]):
            if a[0] <= y <= b[0]:
                k = (y - a[0]) / (b[0] - a[0])
                return [a[i] + (b[i] - a[i]) * k for i in range(6)]
        return list(FAIR[-1])
    glass = []
    for y, taper in ((-3.0, 0.15), (-2.7, 0.7), (-2.3, 0.95), (-1.8, 1.0), (-1.3, 0.92), (-1.0, 0.6), (-0.85, 0.15)):
        _, w, zt, zb, ws, zc = fair_at(y)
        # the blister covers the upper half of the fairing; its ends pinch back into the pearl
        glass.append((y, (w * 0.96 + 0.02) * taper, zt + 0.018 * taper, zc + 0.02, (ws + 0.02) * taper, zc + 0.04 + (zt - zc) * (1 - taper) * 0.5))
    loft(g, glass, 'glass', smooth=True)
    # slim frame bow across the glass, following the fairing
    _, w, zt, zb, ws, zc = fair_at(-1.95)
    g.seg((-(ws + 0.025), -1.95, zt - (zt - zc) * 0.25), (0, -1.95, zt + 0.03), 0.018, 'hullDark', 6)
    g.seg((0, -1.95, zt + 0.03), ((ws + 0.025), -1.95, zt - (zt - zc) * 0.25), 0.018, 'hullDark', 6)
    # dorsal sensor spine and antenna
    g.hexa(taper_pts(0.24, 1.6, 0.16, front=(0.5, 0.6)), 'hullDark', (0, 0.0, 0.83), bevel=0.02)
    g.greeble(rng, (0, 1.4, 0.76), X, Y, Z, 0.6, 1.0, 8, hmax=0.05)
    g.cyl(0.012, 0.012, 0.7, (0.2, 2.2, 1.05), 'hullDark', axis='z', seg=6, bevel=0)
    g.sphere(0.035, (0.2, 2.2, 1.4), 'red', seg=8, rings=6)
    # tail: centre engine, rear light bar
    g.cyl(0.36, 0.42, 0.4, (0, 3.95, 0.05), 'hullDark', seg=24)
    g.cyl(0.3, 0.3, 0.04, (0, 4.16, 0.05), 'engine', seg=24, bevel=0)
    g.box((1.3, 0.03, 0.06), (0, 3.82, 0.3), 'amber', bevel=0)
    # chin mining laser in a faired pod that tapers into the keel
    loft(g, [(-3.85, 0.04, -0.14, -0.24, 0.03, -0.19), (-3.4, 0.12, -0.1, -0.3, 0.1, -0.2), (-2.4, 0.16, -0.12, -0.36, 0.14, -0.24),
             (-1.6, 0.06, -0.2, -0.32, 0.05, -0.26)], 'hullDark', smooth=True)
    g.cyl(0.045, 0.045, 0.35, (0, -3.95, -0.19), 'hull', seg=12)
    g.cyl(0.055, 0.05, 0.06, (0, -4.13, -0.19), 'candy', seg=12)
    g.greeble(rng, (0, 0.5, -0.47), X, Y, -Z, 1.0, 2.5, 12, hmax=0.05)

    root = g.build()
    empty('anchor_nose', (0, -4.18, -0.19), root)
    empty('anchor_exhaust_0', (-1.5, 4.68, -0.05), root)
    empty('anchor_exhaust_1', (1.5, 4.68, -0.05), root)
    empty('anchor_exhaust_2', (0, 4.2, 0.05), root)
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


def build_hauler_proc():
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


# ================================================================ lathe / truss helpers
def bm_lathe(profile, seg=32, closed=False, cap=True):
    """Surface of revolution about Z through (r, z) points (r = 0 makes a pole). closed joins the last
    point back to the first (a solid ring/bell with wall thickness); cap fills open end rings."""
    bm = bmesh.new()
    angs = [2 * math.pi * i / seg for i in range(seg)]
    rings = [bm.verts.new((0, 0, z)) if r <= 1e-6 else [bm.verts.new((r * math.cos(a), r * math.sin(a), z)) for a in angs] for r, z in profile]
    pairs = list(zip(rings, rings[1:])) + ([(rings[-1], rings[0])] if closed else [])
    for A, B in pairs:
        for i in range(seg):
            j = (i + 1) % seg
            if isinstance(A, list) and isinstance(B, list):
                bm.faces.new((A[i], A[j], B[j], B[i]))
            elif isinstance(A, list):
                bm.faces.new((A[i], A[j], B))
            elif isinstance(B, list):
                bm.faces.new((A, B[j], B[i]))
    if cap and not closed:
        for R in (rings[0], rings[-1]):
            if isinstance(R, list):
                bm.faces.new(R)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return bm


AXIS_ROT = {'z': (0, 0, 0), 'y': (-math.pi / 2, 0, 0), 'x': (0, math.pi / 2, 0)}


def lathe(g, profile, loc, mat, axis='z', seg=32, closed=False, cap=True, bevel=0.0):
    return g.add(bm_lathe(profile, seg, closed, cap), mat, loc, AXIS_ROT[axis], bevel)


def bell(g, loc, r0, r1, length, axis='y', sign=1, mat='hullDark', glow='engine', seg=28):
    """Rocket nozzle: throat r0 at loc flaring to exit r1 `length` along +axis (sign -1 flips), with a
    lip, a wall thickness and a glow disc down the throat."""
    prof = [(r0, 0), (r0 + (r1 - r0) * 0.35, length * 0.45), (r1 * 0.97, length * 0.9), (r1, length),
            (r1 + 0.03, length), (r1 + 0.02, length * 0.9), (r0 + (r1 - r0) * 0.37 + 0.04, length * 0.45), (r0 + 0.06, 0)]
    prof = [(r, h * sign) for r, h in prof]
    lathe(g, prof, loc, mat, axis, seg, closed=True)
    d = Vector({'x': (1, 0, 0), 'y': (0, 1, 0), 'z': (0, 0, 1)}[axis]) * sign
    if glow:
        g.cyl(r0 * 1.05, r0 * 1.05, 0.02, tuple(Vector(loc) + d * 0.05), glow, axis=axis, seg=seg, bevel=0)
    return g


def truss(g, a, b, w, mat='hullDark', bays=None, r=0.035, up=None):
    """Square lattice truss from a to b: four longerons, a frame at every bay and zig-zag diagonals."""
    a, b = Vector(a), Vector(b)
    d = b - a
    n = d.normalized()
    up = Vector(up) if up else (Z if abs(n.z) < 0.9 else X)
    u = n.cross(up).normalized()
    v = n.cross(u).normalized()
    bays = bays or max(1, round(d.length / w))
    cs = [(u * s1 + v * s2) * (w / 2) for s1, s2 in ((1, 1), (-1, 1), (-1, -1), (1, -1))]
    for c in cs:
        g.seg(a + c, b + c, r, mat, 6)
    for k in range(bays + 1):
        p = a + d * (k / bays)
        for i in range(4):
            g.seg(p + cs[i], p + cs[(i + 1) % 4], r * 0.7, mat, 5)
    for k in range(bays):
        p0, p1 = a + d * (k / bays), a + d * ((k + 1) / bays)
        for i in range(4):
            c0, c1 = cs[i], cs[(i + 1) % 4]
            g.seg(p0 + (c0 if k % 2 else c1), p1 + (c1 if k % 2 else c0), r * 0.6, mat, 5)
    return g


def band_windows(g, r, z, n, w, h, mat='window', axis_rot=None, skip=()):
    """A row of n small lit windows around a Z-axis cylinder of radius r at height z."""
    for k in range(n):
        if k in skip:
            continue
        a = 2 * math.pi * (k + 0.5) / n
        nr = Vector((math.cos(a), math.sin(a), 0))
        u = Vector((-math.sin(a), math.cos(a), 0))
        g.obox((w, h, 0.03), nr * r + Vector((0, 0, z)), u, Z, nr, mat, bevel=0)


def ribs(g, r, zs, mat='hullDark', t=0.06, seg=40):
    for z in zs:
        g.torus(r + t * 0.3, t, (0, 0, z), mat, seg=seg, rseg=6, sx=0.6)


# ================================================================ SEED SHIP  (colony lander)
def build_seed():
    """Colony seed ship: an ~11 m lander that stands on its engines. Ogive crew/cargo hull with panel
    bands, a lit window ring and hatch, four folded solar wings, a service ring with RCS quads, an open
    truss bay of gold-foil propellant spheres around the thrust tube, one big centre bell with four
    verniers, and four articulated landing legs with shock struts and pads. Nose -Y, engines +Y."""
    rng = random.Random(3)
    g = Group('seed')
    # forward hull (lathe along +Y: profile h is the y coordinate)
    lathe(g, [(0, -5.45), (0.3, -5.38), (0.68, -5.12), (1.02, -4.72), (1.3, -4.2), (1.5, -3.6), (1.6, -2.95), (1.6, 0.2), (1.66, 0.3), (1.66, 0.42), (0, 0.42)],
          (0, 0, 0), 'pearl', axis='y', seg=48)
    g.cyl(0.22, 0.3, 0.12, (0, -5.42, 0), 'hullDark', seg=16)
    for y, mat in ((-3.85, 'accent'), (-3.7, 'hullDark'), (-1.15, 'hullDark'), (0.05, 'accent')):
        r = 1.6 if y > -2.95 else 1.43
        g.torus(r + 0.01, 0.045, (0, y, 0), mat, axis='y', seg=48, rseg=6, sx=0.6)
    # window ring and an upper row of small ports
    for k in range(24):
        if k in (5, 6, 17, 18):
            continue
        a = 2 * math.pi * (k + 0.5) / 24
        nr = Vector((math.cos(a), 0, math.sin(a)))
        u = Vector((-math.sin(a), 0, math.cos(a)))
        g.obox((0.24, 0.32, 0.03), nr * 1.605 + Vector((0, -2.45, 0)), u, Y, nr, 'window', bevel=0)
        if k % 2 == 0:
            g.obox((0.12, 0.12, 0.03), nr * 1.52 + Vector((0, -3.35, 0)), u, Y, nr, 'window', bevel=0)
    # crew hatch with amber surround
    nr, u = Vector((1, 0, 0)), Vector((0, 0, 1))
    g.obox((0.9, 1.3, 0.05), nr * 1.6 + Vector((0, -1.8, 0)), u, Y, nr, 'hullDark', bevel=0.02)
    g.obox((0.7, 1.1, 0.06), nr * 1.61 + Vector((0, -1.8, 0)), u, Y, nr, 'hull', bevel=0.02)
    g.obox((0.95, 0.04, 0.07), nr * 1.6 + Vector((0, -2.48, 0)), u, Y, nr, 'amber', bevel=0)
    for k in range(4):
        a = k * math.pi / 2 + math.pi / 4
        nr = Vector((math.cos(a), 0, math.sin(a)))
        u = Vector((-math.sin(a), 0, math.cos(a)))
        # folded solar wing: frame, two cell panels, hinge
        c = nr * 1.66 + Vector((0, -1.3, 0))
        g.obox((1.05, 0.95, 0.05), c + Vector((0, -0.5, 0)), u, Y, nr, 'solar', bevel=0.005)
        g.obox((1.05, 0.95, 0.05), c + Vector((0, 0.5, 0)), u, Y, nr, 'solar', bevel=0.005)
        g.obox((1.12, 2.1, 0.035), c - nr * 0.03, u, Y, nr, 'hullDark', bevel=0.005)
        g.obox((1.14, 0.06, 0.08), c, u, Y, nr, 'hullLight', bevel=0)
        # cargo-bay panel outline and greebles between the wings
        b = k * math.pi / 2
        nb = Vector((math.cos(b), 0, math.sin(b)))
        ub = Vector((-math.sin(b), 0, math.cos(b)))
        if k != 0:
            g.obox((0.8, 1.2, 0.03), nb * 1.6 + Vector((0, -0.6, 0)), ub, Y, nb, 'hullDark', bevel=0.01)
        g.greeble(rng, nb * 1.6 + Vector((0, -3.15, 0)), Y, ub, nb, 0.5, 0.4, 3, hmax=0.05, smax=0.18)
    # service ring with RCS quads
    lathe(g, [(1.66, 0.42), (1.7, 0.5), (1.7, 0.85), (1.45, 0.95), (0, 0.95)], (0, 0, 0), 'hullDark', axis='y', seg=48, cap=False)
    for k in range(4):
        a = k * math.pi / 2
        nr = Vector((math.cos(a), 0, math.sin(a)))
        u = Vector((-math.sin(a), 0, math.cos(a)))
        c = nr * 1.78 + Vector((0, 0.67, 0))
        g.obox((0.32, 0.3, 0.2), c, u, Y, nr, 'hull', bevel=0.02)
        for dv in (-1, 1):
            g.cyl(0.035, 0.05, 0.1, tuple(c + u * dv * 0.2), 'hullDark', axis='x' if abs(u.x) > 0.5 else 'z', seg=8, bevel=0)
            g.cyl(0.035, 0.05, 0.1, tuple(c + Y * dv * 0.2), 'hullDark', seg=8, bevel=0)
    # open truss bay: octagonal frames, longerons, propellant spheres, thrust tube
    for y in (0.95, 2.95):
        g.torus(1.35, 0.06, (0, y, 0), 'hullDark', axis='y', seg=8, rseg=6)
    for k in range(8):
        a = k * math.pi / 4
        p = Vector((math.cos(a) * 1.35, 0, math.sin(a) * 1.35))
        q = Vector((math.cos(a + math.pi / 4) * 1.35, 0, math.sin(a + math.pi / 4) * 1.35))
        g.seg(p + Vector((0, 0.95, 0)), p + Vector((0, 2.95, 0)), 0.045, 'hullDark', 6)
        g.seg(p + Vector((0, 0.95, 0)), q + Vector((0, 2.95, 0)), 0.03, 'hull', 5)
    for k in range(6):
        a = k * math.pi / 3 + math.pi / 6
        c = (math.cos(a) * 0.95, 1.95, math.sin(a) * 0.95)
        g.sphere(0.55, c, 'foil', seg=20, rings=12)
        g.torus(0.56, 0.025, c, 'hullDark', axis='y', seg=20, rseg=4)
    g.cyl(0.42, 0.42, 2.0, (0, 1.95, 0), 'hull', seg=20)
    for y in (1.3, 1.95, 2.6):
        g.torus(0.43, 0.03, (0, y, 0), 'hullDark', axis='y', seg=20, rseg=4)
    # aft bulkhead + engines
    lathe(g, [(0, 2.95), (1.42, 2.95), (1.42, 3.12), (1.2, 3.3), (0, 3.3)], (0, 0, 0), 'hullDark', axis='y', seg=48)
    g.cyl(0.55, 0.45, 0.4, (0, 3.45, 0), 'hull', seg=24)
    bell(g, (0, 3.6, 0), 0.4, 1.05, 1.28, axis='y', mat='hullDark')
    g.torus(0.82, 0.03, (0, 4.3, 0), 'hullLight', axis='y', seg=28, rseg=4)
    for k in range(4):
        a = k * math.pi / 2
        c = Vector((math.cos(a) * 1.15, 3.35, math.sin(a) * 1.15))
        g.cyl(0.16, 0.14, 0.2, tuple(c), 'hull', seg=12)
        bell(g, tuple(c + Vector((0, 0.1, 0))), 0.12, 0.3, 0.55, axis='y', mat='hullDark', seg=16)
    # landing legs at 45 degrees: hinge, main strut with a chrome shock piston, side brace, pad
    for k in range(4):
        a = k * math.pi / 2 + math.pi / 4
        nr = Vector((math.cos(a), 0, math.sin(a)))
        u = Vector((-math.sin(a), 0, math.cos(a)))
        hinge = nr * 1.62 + Vector((0, 0.15, 0))
        foot = nr * 2.95 + Vector((0, 5.42, 0))
        knee = hinge.lerp(foot, 0.55)
        g.obox((0.38, 0.5, 0.25), hinge, u, Y, nr, 'hullDark', bevel=0.03)
        g.seg(hinge, knee, 0.11, 'hull', 10)
        g.seg(knee, foot, 0.065, 'chrome', 10)
        g.cyl(0.14, 0.14, 0.18, tuple(knee), 'hullDark', axis='y', seg=12)
        brace = nr * 1.4 + Vector((0, 2.9, 0))
        for s in (-1, 1):
            g.seg(brace + u * s * 0.35, knee + u * s * 0.06, 0.045, 'hullDark', 6)
        lathe(g, [(0, 5.5), (0.36, 5.5), (0.4, 5.6), (0.3, 5.68), (0, 5.68)], tuple(nr * 2.95), 'hull', axis='y', seg=20)
        g.seg(foot, foot + Vector((0, 0.1, 0)), 0.09, 'hullDark', 8)
    # nose beacon + antennae
    g.sphere(0.07, (0, -5.5, 0), 'red', seg=8, rings=6)
    for s in (-1, 1):
        g.seg((s * 0.9, -4.6, 0.7), (s * 1.0, -5.3, 0.85), 0.012, 'hullDark', 5)
    root = g.build()
    empty('anchor_exhaust_0', (0, 4.95, 0), root)
    return root


# ================================================================ DRONE  (utility robot)
def build_drone_proc():
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


# ================================================================ FRAME  (Vesper EVA exosuit, the player's craft)
def child(obj, parent, loc, rot=(0, 0, 0)):
    """Parent obj with a local (parent-space) transform; parents here are never scaled."""
    obj.parent = parent
    obj.location = loc
    obj.rotation_euler = rot
    bpy.context.view_layer.update()
    return obj


def anchor(name, parent, loc, rot=(0, 0, 0)):
    e = bpy.data.objects.new(name, None)
    e.empty_display_size = 0.2
    bpy.context.scene.collection.objects.link(e)
    return child(e, parent, loc, rot)


def prism(g, c0, w0, d0, c1, w1, d1, mat, bevel=0.03):
    """Armour block lofted between a w0 x d0 rectangle around c0 and a w1 x d1 one around c1."""
    def rect(c, w, d): return [(c[0] - w / 2, c[1] - d / 2, c[2]), (c[0] + w / 2, c[1] - d / 2, c[2]),
                               (c[0] + w / 2, c[1] + d / 2, c[2]), (c[0] - w / 2, c[1] + d / 2, c[2])]
    return g.hexa((rect(c0, w0, d0), rect(c1, w1, d1)), mat, bevel=bevel)


VENDOR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'vendor', 'human-base-meshes',
                      'human-base-meshes-bundle-v1.4.1', 'human_base_meshes_bundle.blend')

# Joint landmarks of Blender Studio's realistic male base mesh (1.68 m, A-pose, facing -Y), x for the right side.
J_SH = Vector((0.18, 0.0, 1.31))     # shoulder
J_WR = Vector((0.378, 0.0, 0.862))   # wrist
ARM_T_ELBOW, ARM_T_WRIST = 0.29, 0.49
J_HIP = Vector((0.095, 0.0, 0.86))
J_KN = Vector((0.135, 0.005, 0.47))
J_AN = Vector((0.17, 0.05, 0.1))
Z_WAIST, Z_PELVIS, Z_NECK = 1.02, 0.95, 1.45
PARTS = ['head', 'pelvis', 'torso', 'thigh_L', 'thigh_R', 'shin_L', 'shin_R', 'foot_L', 'foot_R', 'arm_L', 'arm_R', 'forearm_L', 'forearm_R', 'hand_L', 'hand_R']


def arm_dir(s):
    d = J_WR - J_SH
    return Vector((s * d.x, 0, d.z)).normalized()


def arm_coords(c):
    """(t along the arm from the shoulder, distance from the arm axis) in the XZ plane."""
    p = Vector((abs(c.x) - J_SH.x, c.z - J_SH.z))
    d = Vector((J_WR.x - J_SH.x, J_WR.z - J_SH.z)).normalized()
    return p.dot(d), abs(p.x * d.y - p.y * d.x)


def classify(c):
    side = 'R' if c.x > 0 else 'L'
    t, perp = arm_coords(c)
    if t > 0 and perp < 0.078 and abs(c.x) > 0.13 and c.z < 1.42 and (c.z > 1.2 or abs(c.x) > 0.17):
        return f'arm_{side}' if t < ARM_T_ELBOW else f'forearm_{side}' if t < ARM_T_WRIST + 0.03 else f'hand_{side}'
    if c.z > Z_NECK + 0.02:
        return 'head'
    if c.z > Z_WAIST:
        return 'torso'
    if c.z > J_HIP.z:
        return 'pelvis'
    if c.z > J_KN.z:
        return f'thigh_{side}'
    if c.z > 0.115:
        return f'shin_{side}'
    return f'foot_{side}'


def load_body():
    """The sculpted body as a bmesh in world space, centred on x, head removed, smoothed and
    inflated into a pressure-garment layer; each face tagged with the rigid part it rides on."""
    with bpy.data.libraries.load(VENDOR, link=False) as (src, dst):
        dst.objects = ['GEO-body_male_realistic']
    o = dst.objects[0]
    bm = bmesh.new()
    bm.from_mesh(o.data)  # base level of the multires sculpt: clean, smooth quads
    bmesh.ops.transform(bm, matrix=o.matrix_world, verts=bm.verts)
    xs = [v.co.x for v in bm.verts]
    bmesh.ops.translate(bm, vec=Vector((-(max(xs) + min(xs)) / 2, 0, 0)), verts=bm.verts)
    bpy.data.objects.remove(o)
    tag = bm.faces.layers.int.new('part')
    for f in bm.faces:
        f[tag] = PARTS.index(classify(f.calc_center_median()))
    # pressure garment: wash out anatomy, then inflate (thinner over the hands)
    for _ in range(3):
        bmesh.ops.smooth_vert(bm, verts=bm.verts, factor=0.5, use_axis_x=True, use_axis_y=True, use_axis_z=True)
    bm.normal_update()
    hand = {PARTS.index('hand_L'), PARTS.index('hand_R')}
    off = {}
    for v in bm.verts:
        on_hand = any(f[tag] in hand for f in v.link_faces)
        on_foot = any(PARTS[f[tag]].startswith('foot') for f in v.link_faces)
        off[v] = v.normal * (0.01 if on_hand else 0.036 if on_foot else 0.026)
    for v, d in off.items():
        v.co += d
    bmesh.ops.smooth_vert(bm, verts=bm.verts, factor=0.3, use_axis_x=True, use_axis_y=True, use_axis_z=True)
    bm.normal_update()
    return bm, tag


def region(bm, tag, keep):
    """Copy of the faces for which keep(part_name, centre, normal) is true."""
    out = bm.copy()
    t = out.faces.layers.int.get('part')
    bmesh.ops.delete(out, geom=[f for f in out.faces if not keep(PARTS[f[t]], f.calc_center_median(), f.normal)], context='FACES')
    return out


def plate(bm, tag, keep, mat, g, off=0.006, thick=0.012, rounds=6, led=None):
    """Armour panel contoured to the suit: a region lifted off the surface, outline rounded, given
    thickness. led(midpoint) picks outline edges that get an LED light strip, like a car's DRLs."""
    p = region(bm, tag, keep)
    if not p.faces:
        p.free()
        return
    for _ in range(rounds):
        edge = [v for v in p.verts if v.is_boundary]
        bmesh.ops.smooth_vert(p, verts=edge, factor=0.5, use_axis_x=True, use_axis_y=True, use_axis_z=True)
    p.normal_update()
    for v in p.verts:
        v.co += v.normal * off
    strip = [(e.verts[0].co + e.verts[0].normal * 0.004, e.verts[1].co + e.verts[1].normal * 0.004)
             for e in p.edges if e.is_boundary and led and led((e.verts[0].co + e.verts[1].co) / 2)]
    bmesh.ops.solidify(p, geom=p.faces[:], thickness=-thick)
    bmesh.ops.recalc_face_normals(p, faces=p.faces)
    g.add(p, mat, bevel=0)
    for a, b in strip:
        g.seg(tuple(a), tuple(b), 0.0035, 'cyan', seg=6)


def fit_ring(bm, c, d, pad=0.008, maxr=0.14):
    """Radius of the suit's cross-section around axis d through c (median over a thin slab)."""
    rs = sorted(r for r in (((v.co - c) - d * (v.co - c).dot(d)).length for v in bm.verts if abs((v.co - c).dot(d)) < 0.012) if r < maxr)
    return (rs[len(rs) // 2] if rs else 0.06) + pad


def ring(g, c, d, R, r=0.014, mat='chrome', sx=1.0):
    """Bearing ring of radius R around axis d through c."""
    t = bm_torus(R, r, 36, 6, 'z', sx)
    m = Matrix.Translation(Vector(c)) @ Vector((0, 0, 1)).rotation_difference(Vector(d).normalized()).to_matrix().to_4x4()
    g.add(t, mat, bevel=0, pre=m)


def dome(g, c, r, scale, tilt, mat, cut=-0.25, thick=0.01):
    """Shoulder cap: the top of a sphere, scaled and tilted, given thickness."""
    b = bm_sphere(r, 28, 16)
    bmesh.ops.delete(b, geom=[v for v in b.verts if v.co.z < r * cut], context='VERTS')
    bmesh.ops.scale(b, vec=Vector(scale), verts=b.verts)
    bmesh.ops.solidify(b, geom=b.faces[:], thickness=-thick)
    bmesh.ops.recalc_face_normals(b, faces=b.faces)
    g.add(b, mat, bevel=0, pre=Matrix.Translation(Vector(c)) @ Euler(tilt).to_matrix().to_4x4())


def build_frame():
    """Vesper EVA exosuit, the player's craft, built over Blender Studio's realistic male base mesh
    (CC0, blender/vendor; fetch human-base-meshes-bundle-v1.4.1.zip from blender.org/download/demo).
    The body becomes a pressure-garment layer split into rigid segments at the joints (as on real
    hard suits); contoured armour plates, bearing rings, domed shoulder caps, armoured boots, a
    pressure helmet with a gold sun visor, a life-support pack and MMU thruster pods go on top.
    Joints: pelvis > thigh_* > shin_* > foot_*, pelvis > torso > head / booster_* / arm_* > forearm_*.
    Jets carry anchor_exhaust_* (local +Y is the jet): 0-1 thruster pods, 2-3 boot soles, 4-5 palms.
    The right palm carries anchor_muzzle (cutting laser)."""
    if not os.path.exists(VENDOR):
        raise SystemExit(f'missing {VENDOR}: download the Human Base Meshes bundle from blender.org')
    rng = random.Random(29)
    bm, tag = load_body()
    root = empty('frame', (0, 0, 0))
    G = {n: Group(n, uvscale=2) for n in ['pelvis', 'torso', 'head', 'thigh_L', 'thigh_R', 'shin_L', 'shin_R', 'foot_L', 'foot_R', 'arm_L', 'arm_R', 'forearm_L', 'forearm_R']}

    # pressure garment, one rigid segment per part (hands ride on the forearms, in glove material)
    for n in PARTS[1:]:  # the head becomes the helmet below
        g = G[n.replace('hand', 'forearm')]
        g.add(region(bm, tag, lambda p, c, nr, n=n: p == n), 'hullDark' if n.startswith('hand') else 'pearl' if n.startswith('foot') else 'carbon', bevel=0)

    # Bodywork, styled like a supercar: pearl paint panels split by shut lines over a gloss carbon
    # tub, candy-blue accent panels, chrome bearing rings, LED light strips along panel edges.
    # ---- torso: split chest panels with LED lower edges, abdominal band, side intakes, upper back
    plate(bm, tag, lambda p, c, n: p == 'torso' and 1.1 < c.z < 1.42 and n.y < -0.25 and abs(c.x) > 0.012, 'pearl', G['torso'], thick=0.018,
          led=lambda m: m.z < 1.17 and abs(m.x) > 0.03)
    plate(bm, tag, lambda p, c, n: p == 'torso' and 1.03 < c.z < 1.1 and n.y < -0.3 and abs(c.x) > 0.01, 'candy', G['torso'], thick=0.014)
    plate(bm, tag, lambda p, c, n: p == 'torso' and 1.06 < c.z < 1.3 and abs(n.x) > 0.7, 'candy', G['torso'], led=lambda m: m.y < -0.06)
    plate(bm, tag, lambda p, c, n: p == 'torso' and c.z > 1.3 and n.y > 0.2 and n.z > 0.2, 'pearl', G['torso'])
    # ---- pelvis: brief, hip panels
    plate(bm, tag, lambda p, c, n: p == 'pelvis' and n.y < -0.35, 'candy', G['pelvis'])
    plate(bm, tag, lambda p, c, n: p == 'pelvis' and abs(n.x) > 0.6, 'pearl', G['pelvis'], thick=0.016)
    plate(bm, tag, lambda p, c, n: p == 'pelvis' and n.y > 0.5 and c.z > 0.9, 'pearl', G['pelvis'])
    for s, side in ((-1, 'L'), (1, 'R')):
        # ---- legs: two-piece thigh panels, outer candy strake, knee cap, two-piece greave, calf, boot
        plate(bm, tag, lambda p, c, n: p == f'thigh_{side}' and 0.695 < c.z < 0.82 and n.y < -0.2, 'pearl', G[f'thigh_{side}'], thick=0.018,
              led=lambda m: m.z < 0.71)
        plate(bm, tag, lambda p, c, n: p == f'thigh_{side}' and 0.55 < c.z < 0.68 and n.y < -0.2, 'pearl', G[f'thigh_{side}'], thick=0.018)
        plate(bm, tag, lambda p, c, n: p == f'thigh_{side}' and 0.55 < c.z < 0.8 and n.y >= -0.2 and n.x * s > 0.6, 'candy', G[f'thigh_{side}'])
        plate(bm, tag, lambda p, c, n: p == f'shin_{side}' and 0.4 < c.z < 0.47 and n.y < -0.35, 'candy', G[f'shin_{side}'], off=0.012, thick=0.016)
        plate(bm, tag, lambda p, c, n: p == f'shin_{side}' and 0.295 < c.z < 0.39 and n.y < -0.05, 'pearl', G[f'shin_{side}'], thick=0.018,
              led=lambda m: m.z < 0.31)
        plate(bm, tag, lambda p, c, n: p == f'shin_{side}' and 0.17 < c.z < 0.28 and n.y < -0.05, 'pearl', G[f'shin_{side}'], thick=0.018)
        plate(bm, tag, lambda p, c, n: p == f'shin_{side}' and 0.2 < c.z < 0.4 and n.y > 0.4, 'candy', G[f'shin_{side}'])
        # armoured boot: the inflated foot in pearl over a rounded mag-lock sole, with a cuff ring
        fb = [v.co for f in bm.faces if PARTS[f[tag]] == f'foot_{side}' for v in f.verts]
        lo = Vector((min(v.x for v in fb), min(v.y for v in fb), min(v.z for v in fb)))
        hi = Vector((max(v.x for v in fb), max(v.y for v in fb), max(v.z for v in fb)))
        G[f'foot_{side}'].add(bm_box(hi.x - lo.x - 0.01, hi.y - lo.y, 0.025), 'hullDark', ((lo.x + hi.x) / 2, (lo.y + hi.y) / 2, lo.z + 0.006), bevel=0.012, seg=3)
        AN = Vector((s * J_AN.x, J_AN.y, J_AN.z + 0.06))
        ring(G[f'shin_{side}'], AN, Vector((0, 0, 1)), fit_ring(bm, AN, Vector((0, 0, 1)), 0.006), 0.018, 'pearl')
        # ---- arms: bicep sleeve, gauntlet, layered shoulder caps
        AD = arm_dir(s)
        OUT = Vector((s * abs(AD.z), 0, abs(AD.x)))  # off the arm axis, up and away from the body
        plate(bm, tag, lambda p, c, n: p == f'arm_{side}' and 0.07 < arm_coords(c)[0] < 0.26 and n.dot(OUT) > -0.2 and n.y < 0.5, 'pearl', G[f'arm_{side}'], thick=0.016,
              led=lambda m: arm_coords(m)[0] > 0.24)
        plate(bm, tag, lambda p, c, n: p == f'forearm_{side}' and 0.31 < arm_coords(c)[0] < 0.47, 'pearl', G[f'forearm_{side}'], off=0.008, thick=0.018, rounds=3,
              led=lambda m: arm_coords(m)[0] > 0.45)
        SH = Vector((s * J_SH.x, 0, J_SH.z))
        dome(G[f'arm_{side}'], SH + Vector((s * 0.025, 0, 0.035)), 0.12, (1.0, 1.08, 0.75), (0, s * 0.45, 0), 'candy')
        dome(G[f'arm_{side}'], SH + Vector((s * 0.03, 0, 0.06)), 0.11, (0.95, 1.0, 0.7), (0, s * 0.45, 0), 'pearl', thick=0.012)
        EL = SH + AD * ARM_T_ELBOW
        WR = SH + AD * ARM_T_WRIST
        # ---- bearing rings fitted to the suit's cross-sections
        ring(G[f'arm_{side}'], SH + AD * 0.04, AD, fit_ring(bm, SH + AD * 0.04, AD, 0.004), 0.016)
        ring(G[f'forearm_{side}'], EL + AD * 0.015, AD, fit_ring(bm, EL + AD * 0.015, AD))
        ring(G[f'forearm_{side}'], WR, AD, fit_ring(bm, WR, AD, 0.012, 0.065), 0.013, 'candy')
        KN = Vector((s * J_KN.x, J_KN.y, J_KN.z))
        ring(G[f'shin_{side}'], KN + Vector((0, 0, -0.035)), Vector((0, 0, 1)), fit_ring(bm, KN + Vector((0, 0, -0.035)), Vector((0, 0, 1))))
        ring(G[f'thigh_{side}'], Vector((s * 0.11, 0.0, 0.83)), Vector((0, 0, 1)), fit_ring(bm, Vector((s * 0.11, 0.0, 0.83)), Vector((0, 0, 1))) - 0.004, 0.016)
    ring(G['torso'], Vector((0, -0.03, Z_WAIST + 0.01)), Vector((0, 0, 1)), 0.165, 0.02, sx=1.0)
    ring(G['torso'], Vector((0, -0.02, Z_NECK - 0.005)), Vector((0, 0, 1)), 0.1, 0.022)

    # ---- chest details: hex power core and display & control module, placed on the plate
    tr = G['torso']
    tr.cyl(0.04, 0.04, 0.03, (0, -0.172, 1.28), 'hullDark', seg=6, bevel=0.004)
    tr.cyl(0.028, 0.028, 0.012, (0, -0.19, 1.28), 'cyan', seg=6, bevel=0)
    tr.box((0.13, 0.05, 0.065), (0, -0.165, 1.17), 'hullDark', bevel=0.012)
    tr.box((0.07, 0.008, 0.03), (-0.02, -0.191, 1.175), 'cyan', bevel=0)
    for i, m in enumerate(('green', 'amber', 'red')):
        tr.sphere(0.006, (0.04, -0.192, 1.19 - i * 0.015), m, seg=8, rings=6)
    # ---- life-support pack: rear-entry hatch, O2 tanks, radiator fins, antenna
    tr.add(bm_box(0.36, 0.15, 0.46), 'pearl', (0, 0.2, 1.17), bevel=0.045, seg=4)
    tr.torus(0.12, 0.01, (0, 0.278, 1.17), 'hullDark', axis='y', seg=36, rseg=6)
    tr.box((0.1, 0.025, 0.018), (0, 0.285, 1.24), 'hullDark', bevel=0.005)
    tr.box((0.37, 0.01, 0.022), (0, 0.276, 1.35), 'accent', bevel=0)
    for s in (-1, 1):
        tr.cyl(0.04, 0.04, 0.3, (s * 0.12, 0.3, 1.16), 'hullLight', axis='z', seg=20)
        tr.sphere(0.04, (s * 0.12, 0.3, 1.31), 'hullLight', seg=16, rings=10)
        tr.sphere(0.04, (s * 0.12, 0.3, 1.01), 'hullLight', seg=16, rings=10)
        tr.box((0.01, 0.01, 0.08), (s * 0.12, 0.341, 1.16), 'green', bevel=0)
    for i in range(5):
        tr.box((0.32, 0.007, 0.055), (0, 0.14 + i * 0.025, 1.43), 'hullLight', bevel=0)
    tr.box((0.34, 0.13, 0.012), (0, 0.19, 1.405), 'hullDark', bevel=0.003)
    tr.greeble(rng, (0, 0.2, 0.94), X, Y, -Z, 0.3, 0.12, 6, mats=('hullDark', 'hull'), hmax=0.025, smax=0.06)
    tr.cyl(0.004, 0.004, 0.3, (-0.15, 0.24, 1.55), 'hullDark', axis='z', seg=6, bevel=0)
    tr.sphere(0.01, (-0.15, 0.24, 1.7), 'red', seg=8, rings=6)

    # ---- armoured helmet: a shell that follows the real skull, a faceted faceplate built from
    # designed cross-sections (narrow chin, cheek planes, brow ridge, centre crease), angular glowing
    # eye slits, swept V-fin crest with a forehead sensor, ear sensor pods, jaw vents
    h = G['head']
    # faceplate rows: (z, half width, front depth, side depth)
    ROWS = [(1.468, 0.03, -0.15, -0.11), (1.495, 0.062, -0.165, -0.09), (1.525, 0.082, -0.178, -0.07), (1.555, 0.095, -0.186, -0.058),
            (1.585, 0.102, -0.192, -0.05), (1.615, 0.102, -0.196, -0.046), (1.64, 0.092, -0.188, -0.05)]
    COLS = [-1, -0.72, -0.4, -0.14, 0, 0.14, 0.4, 0.72, 1]

    def row_at(z):
        z = min(max(z, ROWS[0][0]), ROWS[-1][0])
        for a, b in zip(ROWS, ROWS[1:]):
            if a[0] <= z <= b[0]:
                k = (z - a[0]) / (b[0] - a[0])
                return tuple(a[i] + (b[i] - a[i]) * k for i in range(1, 4))

    def mask_y(x, z):
        w, yf, ys = row_at(z)
        u = min(1.0, abs(x) / w)
        return yf + (ys - yf) * u ** 1.6 - (0.006 if abs(x) < 0.004 else 0)

    shell = region(bm, tag, lambda p, c, n: p == 'head')
    bmesh.ops.delete(shell, geom=[v for v in shell.verts if v.co.z < (1.5 if v.co.y < -0.06 else 1.468)], context='VERTS')
    for _ in range(10):
        bmesh.ops.smooth_vert(shell, verts=[v for v in shell.verts if not v.is_boundary], factor=0.5, use_axis_x=True, use_axis_y=True, use_axis_z=True)
    for _ in range(6):
        bmesh.ops.smooth_vert(shell, verts=[v for v in shell.verts if v.is_boundary], factor=0.5, use_axis_x=True, use_axis_y=True, use_axis_z=True)
    shell.normal_update()
    for v in shell.verts:
        v.co += v.normal * 0.012
    # open the face: the faceplate fills the opening, its edge meets the shell, a pearl trim hides the seam
    pts = [v.co.copy() for v in shell.verts]

    def surf_y(x, z):
        near = [p.y for p in pts if abs(p.x - x) < 0.012 and abs(p.z - z) < 0.012 and p.y < -0.02]
        return min(near) if near else None
    ROWS[:] = [(z, w, yf, (surf_y(w, z) or ys) + 0.002) for z, w, yf, ys in ROWS]
    inside = lambda p: ROWS[0][0] - 0.02 < p.z < ROWS[-1][0] and abs(p.x) < row_at(p.z)[0] - 0.006 and p.y < -0.03
    bmesh.ops.delete(shell, geom=[f for f in shell.faces if all(inside(v.co) for v in f.verts)], context='FACES')
    hv = [v.co.copy() for v in shell.verts]
    h.add(shell, 'pearl', bevel=0)
    rim = [(-ROWS[r][1], ROWS[r][0], ROWS[r][3]) for r in range(len(ROWS))] + [(ROWS[-1][1] * u, ROWS[-1][0], mask_y(ROWS[-1][1] * u, ROWS[-1][0])) for u in (-0.72, -0.4, 0, 0.4, 0.72)] \
        + [(ROWS[r][1], ROWS[r][0], ROWS[r][3]) for r in reversed(range(len(ROWS)))]
    for (x0, z0, y0), (x1, z1, y1) in zip(rim, rim[1:]):
        h.seg((x0, y0, z0), (x1, y1, z1), 0.011, 'pearl', seg=10)
        h.sphere(0.011, (x1, y1, z1), 'pearl', seg=10, rings=8)

    fp = bmesh.new()
    grid = [[fp.verts.new((u * w, mask_y(u * w, z) if u else yf - 0.006, z)) for u in COLS] for z, w, yf, ys in ROWS]
    for r in range(len(ROWS) - 1):
        for c in range(len(COLS) - 1):
            fp.faces.new((grid[r][c], grid[r][c + 1], grid[r + 1][c + 1], grid[r + 1][c]))
    bmesh.ops.recalc_face_normals(fp, faces=fp.faces)
    if fp.faces[0].normal.y > 0:
        bmesh.ops.reverse_faces(fp, faces=fp.faces)
    bmesh.ops.solidify(fp, geom=fp.faces[:], thickness=-0.008)
    bmesh.ops.recalc_face_normals(fp, faces=fp.faces)
    h.add(fp, 'carbon', bevel=0, smooth=False)  # flat-shaded facets read as machined armour
    on_mask = lambda x, z, lift=0.013: Vector((x, mask_y(x, z) - lift, z))  # just proud of the faceplate
    for s in (-1, 1):
        # eye slit: a sharp sliver, low by the nose, swept up toward the temple
        a, m, b = on_mask(s * 0.016, 1.582), on_mask(s * 0.045, 1.588), on_mask(s * 0.078, 1.603)
        for p0, p1, t0, t1 in ((a, m, 0.007, 0.011), (m, b, 0.011, 0.004)):
            h.hexa(([p0 + Vector((0, 0, -t0 / 2)), p1 + Vector((0, 0, -t1 / 2)), p1 + Vector((0, 0.005, -t1 / 2)), p0 + Vector((0, 0.005, -t0 / 2))],
                    [p0 + Vector((0, 0, t0 / 2)), p1 + Vector((0, 0, t1 / 2)), p1 + Vector((0, 0.005, t1 / 2)), p0 + Vector((0, 0.005, t0 / 2))]), 'cyan', bevel=0)
        # jaw vents
        for k in range(3):
            g0 = on_mask(s * (0.02 + k * 0.014), 1.505, 0.011)
            h.box((0.007, 0.006, 0.018), tuple(g0), 'cyan' if k == 0 else 'hull', bevel=0)
        # cheek guard sweeping back from the faceplate edge
        c0, c1 = on_mask(s * 0.07, 1.52, 0.006), on_mask(s * 0.094, 1.56, 0.006)
        h.hexa(([c0, c0 + Vector((s * 0.03, 0.06, -0.012)), c0 + Vector((s * 0.03, 0.07, -0.008)), c0 + Vector((0, 0.012, 0.004))],
                [c1, c1 + Vector((s * 0.022, 0.07, 0.004)), c1 + Vector((s * 0.022, 0.08, 0.008)), c1 + Vector((0, 0.012, 0.008))]), 'candy', bevel=0.002)
        # ear sensor pods with a glowing ring and a swept antenna
        ep = Vector((s * 0.112, -0.03, 1.578))
        h.cyl(0.034, 0.038, 0.03, tuple(ep), 'hullDark', axis='x', seg=24)
        h.torus(0.028, 0.004, tuple(ep + Vector((s * 0.016, 0, 0))), 'cyan', axis='x', seg=24, rseg=4)
        h.cyl(0.019, 0.019, 0.012, tuple(ep + Vector((s * 0.02, 0, 0))), 'pearl', axis='x', seg=16)
        h.hexa(([ep + Vector((s * 0.012, 0.0, 0.02)), ep + Vector((s * 0.02, 0.0, 0.02)), ep + Vector((s * 0.02, 0.02, 0.02)), ep + Vector((s * 0.012, 0.02, 0.02))],
                [ep + Vector((s * 0.02, 0.08, 0.065)), ep + Vector((s * 0.024, 0.08, 0.065)), ep + Vector((s * 0.024, 0.09, 0.065)), ep + Vector((s * 0.02, 0.09, 0.065))]), 'candy', bevel=0)
        # V-fin: tapered blade from the brow, swept up and out, with a glowing edge
        r0 = on_mask(s * 0.01, 1.64, 0.02)
        tip = r0 + Vector((s * 0.15, 0.055, 0.115))
        h.hexa(([r0 + Vector((0, 0, -0.012)), r0 + Vector((0, 0.03, -0.012)), r0 + Vector((s * 0.003, 0.03, 0.014)), r0 + Vector((s * 0.003, 0, 0.014))],
                [tip + Vector((0, 0, -0.003)), tip + Vector((0, 0.008, -0.003)), tip + Vector((s * 0.002, 0.008, 0.003)), tip + Vector((s * 0.002, 0, 0.003))]), 'candy', bevel=0.002)
        h.hexa(([r0 + Vector((s * 0.004, -0.002, 0.004)), r0 + Vector((s * 0.004, 0.012, 0.004)), r0 + Vector((s * 0.006, 0.012, 0.012)), r0 + Vector((s * 0.006, -0.002, 0.012))],
                [tip + Vector((-s * 0.01, -0.002, -0.006)), tip + Vector((-s * 0.01, 0.004, -0.006)), tip + Vector((-s * 0.008, 0.004, -0.003)), tip + Vector((-s * 0.008, -0.002, -0.003))]), 'cyan', bevel=0)
    # forehead sensor gem in a pearl crest housing, and a dorsal ridge
    fc = on_mask(0, 1.64, 0.022)
    h.hexa(([fc + Vector((-0.02, 0, -0.02)), fc + Vector((0.02, 0, -0.02)), fc + Vector((0.02, 0.03, -0.02)), fc + Vector((-0.02, 0.03, -0.02))],
            [fc + Vector((-0.012, -0.004, 0.022)), fc + Vector((0.012, -0.004, 0.022)), fc + Vector((0.012, 0.03, 0.026)), fc + Vector((-0.012, 0.03, 0.026))]), 'pearl', bevel=0.003)
    h.sphere(0.009, tuple(fc + Vector((0, -0.006, 0.002))), 'cyan', scale=(1, 0.6, 1.3), seg=12, rings=8)
    top = max(p.z for p in hv)
    h.hexa(([(-0.012, -0.08, top - 0.03), (0.012, -0.08, top - 0.03), (0.012, 0.09, top - 0.03), (-0.012, 0.09, top - 0.03)],
            [(-0.006, -0.06, top + 0.012), (0.006, -0.06, top + 0.012), (0.006, 0.07, top + 0.006), (-0.006, 0.07, top + 0.006)]), 'candy', bevel=0.003)
    h.torus(0.098, 0.016, (0, -0.025, 1.47), 'pearl', seg=36, rseg=6)  # helmet seal over the neck ring

    # ---- build the hierarchy with origins on the joints
    pelvis = G['pelvis'].build((0, 0, Z_PELVIS), root)
    torso = G['torso'].build((0, 0, Z_WAIST), pelvis)
    G['head'].build((0, -0.02, Z_NECK), torso)
    for s, side in ((-1, 'L'), (1, 'R')):
        m = lambda v: Vector((s * v.x, v.y, v.z))
        thigh = G[f'thigh_{side}'].build(tuple(m(J_HIP)), pelvis)
        shin = G[f'shin_{side}'].build(tuple(m(J_KN)), thigh)
        foot = G[f'foot_{side}'].build(tuple(m(J_AN)), shin)
        anchor(f'anchor_exhaust_{2 + (s > 0)}', foot, (0, -0.06, -0.105), (math.radians(-90), 0, 0))
        AD = arm_dir(s)
        SH = m(J_SH)
        arm = G[f'arm_{side}'].build(tuple(SH), torso)
        forearm = G[f'forearm_{side}'].build(tuple(SH + AD * ARM_T_ELBOW), arm)
        EL = SH + AD * ARM_T_ELBOW
        jet = Vector((0, 1, 0)).rotation_difference(AD).to_euler()
        palm = SH + AD * (ARM_T_WRIST + 0.13) - EL
        anchor(f'anchor_exhaust_{4 + (s > 0)}', forearm, tuple(palm), tuple(jet))
        if s > 0:
            anchor('anchor_muzzle', forearm, tuple(palm))

        # MMU thruster pods on swing arms off the pack: built pointing back (+Y), tilted up 35°
        b = Group(f'booster_{side}', uvscale=2)
        b.cyl(0.025, 0.025, 0.07, (0, 0, 0), 'hullDark', axis='x', seg=10)
        b.box((0.035, 0.1, 0.035), (s * 0.035, 0.03, 0), 'hull', bevel=0.008)
        b.add(bm_cyl(0.048, 0.052, 0.26, 20, 'y'), 'pearl', (s * 0.07, 0.17, 0), bevel=0.01, seg=3)
        b.torus(0.052, 0.007, (s * 0.07, 0.13, 0), 'hullDark', axis='y', seg=20, rseg=4)
        b.cyl(0.056, 0.065, 0.06, (s * 0.07, 0.32, 0), 'hullDark', seg=20)
        b.cyl(0.05, 0.05, 0.006, (s * 0.07, 0.352, 0), 'engine', seg=20, bevel=0)
        for dz in (-1, 1):
            b.box((0.026, 0.026, 0.022), (s * 0.07, 0.23, dz * 0.06), 'hullDark', bevel=0.004)
        b.box((0.004, 0.15, 0.01), (s * 0.122, 0.17, 0.0), 'cyan', bevel=0)
        b.add(slab((s * 0.1, 0.08, 0.02), (s * 0.1, 0.28, 0.02), (s * 0.42, 0.31, 0.1), (s * 0.42, 0.4, 0.1), 0.01, 0.005), 'hullLight', bevel=0.002)
        for k in range(4):
            u = (k + 1) / 5
            b.box((0.005, 0.17 - u * 0.08, 0.016), (s * (0.1 + 0.32 * u), 0.18 + 0.17 * u, 0.022 + 0.08 * u), 'hullDark', bevel=0)
        b.add(slab((s * 0.11, 0.12, -0.025), (s * 0.11, 0.29, -0.025), (s * 0.3, 0.33, -0.085), (s * 0.3, 0.38, -0.085), 0.008, 0.005), 'candy', bevel=0.002)
        bo = b.build((0, 0, 0))
        child(bo, torso, (s * 0.19, 0.24, 0.31), (math.radians(35), 0, 0))
        anchor(f'anchor_exhaust_{0 if s < 0 else 1}', bo, (s * 0.07, 0.36, 0))
    bm.free()
    return root


# ================================================================ STATION CORE  (Eden)
def build_station():
    """Eden station core, axis +Z (three.js +Y). A segmented spine: big hub drum with lit window bands
    and bearing races; above it a ribbed hab module with port rows, a docking node with four radial
    ports, a lattice truss, an equipment drum in foil and the antenna mast with comm dishes; below it a
    lab module, a node with the two side docking ports, and a service module with radiator fins and RCS
    quads. Saddle trusses at z 3.5 meet the game's solar-wing struts. The habitat ring (child 'ring',
    spun at runtime) has a chamfered lathed cross-section, inner and outer window bands, structural
    ribs, roof greebles and four spokes (pressurised tube + lattice truss + lift car)."""
    rng = random.Random(21)
    g = Group('station', uvscale=0.5)
    # hub drum
    lathe(g, [(0, -1.6), (2.15, -1.6), (2.5, -1.3), (2.5, 1.3), (2.15, 1.6), (0, 1.6)], (0, 0, 0), 'hullLight', seg=56)
    for z in (-1.0, 1.0):
        g.torus(2.53, 0.07, (0, 0, z), 'hullDark', seg=56, rseg=6, sx=0.6)
    band_windows(g, 2.51, 0.5, 40, 0.22, 0.3)
    band_windows(g, 2.51, -0.5, 40, 0.22, 0.3)
    g.cyl(2.17, 2.17, 0.08, (0, 0, 1.58), 'accent', axis='z', seg=56, bevel=0)
    for k in range(8):
        a = k * math.pi / 4 + math.pi / 8
        nr = Vector((math.cos(a), math.sin(a), 0))
        g.sphere(0.06, tuple(nr * 2.52 + Vector((0, 0, 1.18))), 'amber', seg=8, rings=5)
    # --- upper spine
    lathe(g, [(2.15, 1.6), (1.45, 2.25), (0, 2.25)], (0, 0, 0), 'hull', seg=48, cap=False)
    g.cyl(1.4, 1.4, 2.8, (0, 0, 3.65), 'hullLight', axis='z', seg=40)
    ribs(g, 1.4, (2.4, 3.1, 4.2, 4.9), 'hullDark')
    band_windows(g, 1.41, 3.65, 20, 0.16, 0.42, skip=(0, 5, 10, 15))
    for k in range(4):  # saddle trusses for the solar wings (+/-X), greebles on the other faces
        a = k * math.pi / 2
        nr = Vector((math.cos(a), math.sin(a), 0))
        u = Vector((-math.sin(a), math.cos(a), 0))
        if k % 2 == 0:
            truss(g, nr * 1.35 + Vector((0, 0, 3.5)), nr * 2.6 + Vector((0, 0, 3.5)), 0.5, 'hullDark', bays=2, r=0.03)
            g.obox((0.5, 0.5, 0.5), nr * 2.6 + Vector((0, 0, 3.5)), u, Z, nr, 'hull', bevel=0.04)
        else:
            g.greeble(rng, nr * 1.4 + Vector((0, 0, 3.65)), u, Z, nr, 0.9, 2.0, 7, hmax=0.07, smax=0.25)
    # docking node with four radial ports
    g.sphere(1.55, (0, 0, 5.65), 'hullLight', scale=(1, 1, 0.55), seg=40, rings=16)
    g.torus(1.56, 0.06, (0, 0, 5.65), 'hullDark', seg=48, rseg=6, sx=0.6)
    for k in range(4):
        a = k * math.pi / 2 + math.pi / 4
        nr = Vector((math.cos(a), math.sin(a), 0))
        p = nr * 1.75 + Vector((0, 0, 5.65))
        g.seg(nr * 1.2 + Vector((0, 0, 5.65)), p, 0.42, 'hullLight', 20)
        g.seg(p, p + nr * 0.18, 0.52, 'hullDark', 20)
        g.seg(p + nr * 0.18, p + nr * 0.22, 0.4, 'hull', 20)
        for s in (-1, 1):
            g.sphere(0.05, tuple(p + nr * 0.2 + Z * s * 0.48), 'amber', seg=8, rings=5)
    # truss section, equipment drum, mast
    truss(g, (0, 0, 6.35), (0, 0, 7.75), 1.3, 'hullDark', bays=2, r=0.045)
    g.cyl(0.35, 0.35, 1.4, (0, 0, 7.05), 'hull', axis='z', seg=16)
    lathe(g, [(0, 7.75), (1.05, 7.75), (1.1, 7.85), (1.1, 8.55), (0.9, 8.75), (0, 8.75)], (0, 0, 0), 'foil', seg=32)
    g.torus(1.11, 0.04, (0, 0, 8.2), 'hullDark', seg=32, rseg=5)
    g.cyl(0.14, 0.08, 3.7, (0, 0, 10.6), 'hullDark', axis='z', seg=8, bevel=0)
    for z in (9.4, 10.6, 11.6):
        g.cyl(0.25, 0.25, 0.05, (0, 0, z), 'hull', axis='z', seg=10, bevel=0)
    for s, z, R in ((1, 9.6, 0.7), (-1, 10.9, 0.45)):
        c = Vector((s * 0.75, 0, z))
        g.seg(Vector((0, 0, z)), c, 0.035, 'hullDark', 6)
        k = R / 0.7
        prof = [(0, -0.02), (R * 0.5, 0.0), (R, 0.1 * k), (R + 0.03, 0.12 * k), (R * 0.5, 0.03), (0, 0.02)]
        lathe(g, [(rr, h * s) for rr, h in prof], tuple(c + Vector((s * 0.05, 0, 0))), 'hullLight', axis='x', seg=24, closed=True)
        g.seg(c, c + Vector((s * 0.35, 0, 0)), 0.02, 'hullDark', 5)
    # --- lower spine
    lathe(g, [(2.15, -1.6), (1.55, -2.2), (0, -2.2)], (0, 0, 0), 'hull', seg=48, cap=False)
    g.cyl(1.5, 1.5, 2.4, (0, 0, -3.4), 'paintWhite', axis='z', seg=40)
    ribs(g, 1.5, (-2.35, -2.95, -3.85, -4.45), 'hullDark')
    band_windows(g, 1.51, -3.4, 16, 0.3, 0.2, skip=(3, 4, 11, 12))
    for k in range(4):
        a = k * math.pi / 2 + math.pi / 4
        nr = Vector((math.cos(a), math.sin(a), 0))
        u = Vector((-math.sin(a), math.cos(a), 0))
        g.greeble(rng, nr * 1.5 + Vector((0, 0, -3.4)), u, Z, nr, 0.8, 1.6, 6, hmax=0.06, smax=0.22)
    # node with the two side docking ports
    g.cyl(1.3, 1.3, 1.0, (0, 0, -5.1), 'hullLight', axis='z', seg=36)
    for s in (-1, 1):
        g.cyl(0.55, 0.55, 1.9, (s * 2.1, 0, -5.1), 'hullLight', axis='x', seg=24)
        for x in (s * 1.7, s * 2.5):
            g.torus(0.57, 0.04, (x, 0, -5.1), 'hullDark', axis='x', seg=24, rseg=5)
        g.cyl(0.72, 0.72, 0.18, (s * 3.1, 0, -5.1), 'hullDark', axis='x', seg=24)
        g.cyl(0.5, 0.5, 0.05, (s * 3.21, 0, -5.1), 'hull', axis='x', seg=24, bevel=0)
        g.torus(0.62, 0.035, (s * 3.22, 0, -5.1), 'amber', axis='x', seg=24, rseg=4)
    # service module with radiator fins and RCS quads
    g.cyl(1.6, 1.6, 1.4, (0, 0, -6.3), 'hull', axis='z', seg=40)
    g.torus(1.61, 0.05, (0, 0, -5.65), 'yellow', seg=40, rseg=5, sx=0.6)
    for k in range(6):
        a = k * math.pi / 3
        nr = Vector((math.cos(a), math.sin(a), 0))
        u = Vector((-math.sin(a), math.cos(a), 0))
        g.obox((1.0, 1.2, 0.05), nr * 2.1 + Vector((0, 0, -6.3)), nr, Z, u, 'hullLight', bevel=0.01)
        for j in range(5):
            g.obox((0.03, 1.2, 0.08), nr * (1.7 + j * 0.2) + Vector((0, 0, -6.3)), nr, Z, u, 'hullDark', bevel=0)
    for k in range(4):
        a = k * math.pi / 2 + math.pi / 4
        nr = Vector((math.cos(a), math.sin(a), 0))
        u = Vector((-math.sin(a), math.cos(a), 0))
        c = nr * 1.7 + Vector((0, 0, -6.95))
        g.obox((0.3, 0.3, 0.22), c, u, Z, nr, 'hullDark', bevel=0.02)
        for v in (u, -u, Z, -Z):
            g.seg(c + v * 0.15, c + v * 0.26, 0.04, 'hull', 8)
    lathe(g, [(1.6, -7.0), (1.2, -7.35), (0, -7.35)], (0, 0, 0), 'hullDark', seg=40, cap=False)
    g.cyl(0.6, 0.6, 0.3, (0, 0, -7.5), 'hull', axis='z', seg=24)
    root = g.build()

    # --- habitat ring
    r = Group('ring', uvscale=0.5)
    R = 7.0
    prof = [(R - 0.7, -0.9), (R + 0.55, -0.9), (R + 0.78, -0.62), (R + 0.78, 0.62), (R + 0.55, 0.9), (R - 0.7, 0.9), (R - 0.78, 0.7), (R - 0.78, -0.7)]
    lathe(r, prof, (0, 0, 0), 'hullLight', seg=96, closed=True)
    r.torus(R + 0.79, 0.05, (0, 0, 0.42), 'window', seg=96, rseg=4, sx=0.5)
    r.torus(R + 0.79, 0.05, (0, 0, -0.1), 'window', seg=96, rseg=4, sx=0.5)
    r.torus(R - 0.79, 0.04, (0, 0, 0.3), 'window', seg=96, rseg=4, sx=0.5)
    n = 36
    for i in range(n):
        a = 2 * math.pi * i / n
        c = Vector((math.cos(a), math.sin(a), 0))
        u = Vector((-math.sin(a), math.cos(a), 0))
        # rib: a thin frame around the cross-section
        mat = 'accent' if i % 9 == 0 else 'hull'
        r.obox((0.14, 1.9, 0.08), c * (R + 0.82), u, Z, c, mat, bevel=0.01)
        r.obox((0.14, 0.08, 1.62), c * (R + 0.05) + Z * 0.93, u, Z, c, mat, bevel=0.01)
        r.obox((0.14, 0.08, 1.62), c * (R + 0.05) - Z * 0.93, u, Z, c, 'hull', bevel=0.01)
        if i % 2:
            m = Vector((math.cos(a + math.pi / n), math.sin(a + math.pi / n), 0))
            mu = Vector((-m.y, m.x, 0))
            r.greeble(rng, m * (R + 0.05) + Z * 0.9, mu, m, Z, 0.9, 1.1, 3, hmax=0.08, smax=0.3)
        if i % 4 == 0:
            r.sphere(0.06, tuple(c * (R + 0.86) + Z * 0.75), 'amber', seg=8, rings=5)
    for k in range(4):
        a = k * math.pi / 2 + math.pi / 4
        d = Vector((math.cos(a), math.sin(a), 0))
        dp = Vector((-d.y, d.x, 0))
        r.seg(d * 2.4, d * 6.3, 0.3, 'hullLight', 16)
        for t in (3.2, 4.4, 5.6):
            r.seg(d * (t - 0.06), d * (t + 0.06), 0.34, 'hullDark', 16)
        truss(r, d * 2.5 + dp * 0.75, d * 6.3 + dp * 0.75, 0.32, 'hullDark', bays=8, r=0.025)
        r.obox((0.6, 0.5, 0.5), d * 4.0 + dp * 0.75, d, Z, dp, 'yellow', bevel=0.03)
        r.add(bm_cyl(0.55, 0.45, 0.4, 16, 'x'), 'hullDark', tuple(d * 6.3), (0, 0, a), 0.015)
    r.build((0, 0, 0), root)
    return root


# ================================================================ ORBITAL JUNK  (salvage field)
def junk_sat_proc(rng):
    """Dead comsat fallback: foil bus, bent wings, dish."""
    g = Group('junk_sat')
    g.box((1.2, 1.2, 1.5), (0, 0, 0), 'foil', bevel=0.04)
    g.box((1.25, 1.25, 0.1), (0, 0, 0.7), 'hullLight', bevel=0.01)
    for s, c, ax, nv in ((1, (2.5, 0, 0.35), Vector((1, 0, 0.25)), Vector((-0.25, 0, 1))), (-1, (-2.4, 0.2, -0.3), Vector((1, 0.15, -0.3)), Vector((0.3, 0, 1)))):
        g.seg((s * 0.6, 0, 0.1), (s * 1.0, 0, 0.1), 0.04, 'hullDark')
        g.obox((3.0, 1.1, 0.05), c, ax, Y, nv, 'solar', bevel=0.01)
    g.cyl(0.9, 0.2, 0.35, (0, -0.85, 0.3), 'hullLight', seg=20, rot=(0.3, 0, 0))
    g.greeble(rng, (0, 0, 0.75), X, Y, Z, 1.0, 1.0, 6)
    return g.build((0, 0, 0))


def build_junk():
    """Salvage field: five named roots (junk_sat, junk_stage, junk_panel, junk_bus, junk_tank) the game
    picks with instanceChild. junk_sat is "Simple Satellite Low Poly Free" by DjalalxJay (CC-BY); the rest
    are procedural: a spent upper stage with its engine, interstage stubs and torn insulation; a ripped
    solar-array wing on its truss; a crumpled foil sat bus with a dish and thrusters; a split COPV tank."""
    rng = random.Random(9)
    sat = vendor('junk_sat', 'junk_sat', 7.0, axis=0)
    if sat is None:
        junk_sat_proc(rng)

    # spent upper stage (axis Y): ribbed tank barrel, aft skirt with engine bell, torn interstage
    g = Group('junk_stage')
    lathe(g, [(0, -2.9), (0.75, -2.85), (1.12, -2.6), (1.2, -2.3), (1.2, 1.7), (1.24, 1.8), (1.24, 2.1), (0.9, 2.5), (0, 2.5)], (0, 0, 0), 'paintWhite', axis='y', seg=40)
    for y in (-1.6, -0.4, 0.8):
        g.torus(1.21, 0.05, (0, y, 0), 'hullDark', axis='y', seg=40, rseg=5, sx=0.6)
    g.box((0.08, 3.6, 0.5), (1.2, -0.4, 0), 'accent', bevel=0.01)
    for k in range(6):  # stringers on the aft skirt
        a = k * math.pi / 3
        nr = Vector((math.cos(a), 0, math.sin(a)))
        g.obox((0.08, 0.5, 0.06), nr * 1.25 + Vector((0, 1.95, 0)), Vector((-math.sin(a), 0, math.cos(a))), Y, nr, 'hullDark', bevel=0)
    g.cyl(0.4, 0.35, 0.35, (0, 2.65, 0), 'hull', seg=20)
    bell(g, (0, 2.8, 0), 0.25, 0.8, 1.4, axis='y', mat='hullDark', glow=None)
    for k in range(5):  # torn interstage panels sticking up from the forward dome
        a = k * 2 * math.pi / 5 + rng.uniform(-0.2, 0.2)
        nr = Vector((math.cos(a), 0, math.sin(a)))
        u = Vector((-math.sin(a), 0, math.cos(a)))
        h = rng.uniform(0.4, 0.9)
        g.obox((0.7, h, 0.04), nr * 1.18 + Vector((0, -2.35 - h / 2, 0)) + nr * h * 0.15, u, (Y - nr * 0.3).normalized(), nr, 'hull', bevel=0.005)
    for k in range(3):  # strips of insulation peeling off
        a = rng.uniform(0, 2 * math.pi)
        nr = Vector((math.cos(a), 0, math.sin(a)))
        u = Vector((-math.sin(a), 0, math.cos(a)))
        y = rng.uniform(-1.5, 1.0)
        g.obox((0.5, 0.9, 0.02), nr * 1.32 + Vector((0, y, 0)), u, (Y + nr * 0.5).normalized(), nr, 'foil', bevel=0)
    g.build((0, 0, 0))

    # ripped solar-array wing: yoke truss, two hinged panels (one twisted), a dangling half panel
    g = Group('junk_panel')
    truss(g, (-2.6, 0, 0), (-1.5, 0, 0), 0.22, 'hullDark', bays=3, r=0.02)
    for x0, rot in ((-0.0, (0, 0, 0)), (2.7, (0.25, -0.35, 0.1))):
        c = Vector((x0, 0, 0))
        g.box((2.6, 1.4, 0.04), tuple(c), 'solar', bevel=0.004, rot=rot)
        g.box((2.66, 0.05, 0.07), tuple(c + Vector((0, 0.72, 0))), 'hullLight', bevel=0, rot=rot)
        g.box((2.66, 0.05, 0.07), tuple(c + Vector((0, -0.72, 0))), 'hullLight', bevel=0, rot=rot)
        g.box((0.05, 1.46, 0.06), tuple(c + Vector((-1.33, 0, 0))), 'hullLight', bevel=0, rot=rot)
    g.box((1.2, 1.4, 0.04), (4.4, 0.35, -0.55), 'solar', bevel=0.004, rot=(0.4, -0.9, 0.3))
    g.seg((3.95, 0.7, 0.3), (4.2, 0.9, -0.3), 0.015, 'hullDark', 5)
    g.build((0, 0, 0))

    # small sat bus: crumpled gold foil, radiator face, dish, thrusters and whip antennas
    g = Group('junk_bus')
    bm = bm_box(0.9, 0.9, 0.9)
    bmesh.ops.subdivide_edges(bm, edges=bm.edges[:], cuts=4, use_grid_fill=True)
    for v in bm.verts:
        v.co += v.co.normalized() * rng.uniform(-0.025, 0.02)
    g.add(bm, 'foil', bevel=0, smooth=False)
    g.box((0.92, 0.04, 0.8), (0, 0.46, 0), 'hullLight', bevel=0.005)
    for k in range(6):
        g.box((0.86, 0.05, 0.03), (0, 0.48, -0.35 + k * 0.14), 'hullDark', bevel=0)
    g.box((0.92, 0.92, 0.1), (0, 0, -0.5), 'hullDark', bevel=0.01)
    g.cyl(0.12, 0.12, 0.25, (0, 0, 0.58), 'hullLight', axis='z', seg=12)
    lathe(g, [(0, 0.7), (0.3, 0.72), (0.55, 0.85), (0.57, 0.87), (0.3, 0.75), (0, 0.73)], (0, 0, 0), 'hullLight', seg=28, closed=True)
    g.seg((0, 0, 0.73), (0, 0, 1.05), 0.012, 'hullDark', 5)
    for s in (-1, 1):
        g.cyl(0.04, 0.07, 0.12, (s * 0.35, -0.35, -0.6), 'hull', axis='z', seg=10)
    for k in range(3):
        a = k * 2.1
        g.seg((0.4 * math.cos(a), 0.4 * math.sin(a), 0.42), (math.cos(a) * 1.0, math.sin(a) * 1.0, 0.95), 0.012, 'hullDark', 5)
    g.build((0, 0, 0))

    # ruptured composite-overwrapped pressure tank: wrap bands, polar boss, a burst split, broken strut
    g = Group('junk_tank')
    lathe(g, [(0, -1.35), (0.18, -1.33), (0.5, -1.22), (0.78, -0.95), (0.9, -0.55), (0.9, 0.55), (0.78, 0.95), (0.5, 1.22), (0.18, 1.33), (0, 1.35)],
          (0, 0, 0), 'hullLight', axis='y', seg=36)
    for y in (-0.55, -0.2, 0.15, 0.5):
        g.torus(0.91, 0.03, (0, y, 0), 'hullDark', axis='y', seg=36, rseg=4, sx=0.5)
    for s in (-1, 1):
        g.cyl(0.18, 0.2, 0.15, (0, s * 1.38, 0), 'hull', seg=14)
    g.obox((0.5, 0.9, 0.3), Vector((0.78, 0.15, 0.35)), Vector((0, 0, 1)), Y, Vector((0.9, 0, 0.4)).normalized(), 'hullDark', bevel=0.02)
    for k in range(5):  # frayed wrap fibres around the burst
        a = 0.35 + rng.uniform(-0.25, 0.25)
        nr = Vector((math.cos(a), 0, math.sin(a)))
        g.seg(nr * 0.95 + Vector((0, -0.2 + k * 0.17, 0)), nr * (1.15 + rng.uniform(0, 0.25)) + Vector((0, -0.2 + k * 0.17 + rng.uniform(-0.15, 0.15), 0.1)), 0.012, 'hullLight', 4)
    g.seg((0, 1.45, 0), (0.15, 2.1, 0.25), 0.07, 'hull', 8)
    g.seg((0.15, 2.1, 0.25), (0.45, 2.3, 0.2), 0.05, 'hullDark', 8)
    g.build((0, 0, 0))


# ================================================================ imported hero ships (CC-BY, see CREDITS.txt)
def build_skiff():
    """Kestrel Mk II: "Space Fighter" by pirate8888, scaled to a 9.3 m cutter. One main engine in the
    tail (glow disc + exhaust anchor), chin gun at the nose, nav lights on the wingtips."""
    o = vendor('skiff', 'skiff', 9.3)
    if o is None:
        return build_skiff_proc()
    g = Group('skiff_fx')
    g.cyl(0.3, 0.3, 0.02, (0, 4.42, -0.24), 'engine', seg=28, bevel=0)
    g.torus(0.31, 0.02, (0, 4.43, -0.24), 'engineHot', axis='y', seg=28, rseg=5)
    for s in (-1, 1):
        g.sphere(0.04, (s * 3.29, 2.45, -0.08), 'red' if s > 0 else 'green', seg=10, rings=6)
    attach(o, g)
    empty('anchor_nose', (0, -4.72, -0.23), o)
    empty('anchor_exhaust_0', (0, 4.62, -0.24), o)
    empty('anchor_nav_L', (3.32, 2.45, -0.08), o)
    empty('anchor_nav_R', (-3.32, 2.45, -0.08), o)
    empty('anchor_strobe', (0, 4.3, 0.22), o)
    return o


def build_hauler():
    """Mule hauler: "Industrial Ship - Concept by Alexander Preuss" by SleepyHead, scaled to 18 m. Its engine
    emission mesh becomes the game's 'engine' material; the single big bell carries the exhaust anchor."""
    o = vendor('hauler', 'hauler', 18.0, rename={'Engine_Emission': 'engine'})
    if o is None:
        return build_hauler_proc()
    empty('anchor_nose', (0, -9.1, -0.6), o)
    empty('anchor_exhaust_0', (0, 8.7, -0.48), o)
    return o


def build_drone():
    """Utility drone: "Scifi Drone" by Doverlock, a 1.3 m sphere with its lens facing forward (-Y)
    (three.js lookAt aims +Z, which is Blender -Y)."""
    o = vendor('drone', 'drone', 1.3, axis=2, ratio=0.45)
    return o if o is not None else build_drone_proc()


# ---------------------------------------------------------------- export + preview
def export(name):
    path = os.path.join(OUT, f'{name}.glb')
    bpy.ops.export_scene.gltf(filepath=path, export_format='GLB', export_yup=True, export_draco_mesh_compression_enable=True, export_draco_mesh_compression_level=7,
                              export_image_format='WEBP', export_image_quality=82)
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
        cam.location = centre + d.normalized() * radius * 3.2
        cam.rotation_euler = (centre - cam.location).to_track_quat('-Z', 'Y').to_euler()
        bpy.context.view_layer.update()
        sc.render.filepath = os.path.join(PREVIEW, f'{name}_{i}.png')
        bpy.ops.render.render(write_still=True)
    bpy.data.objects.remove(cam)


BUILDERS = {'skiff': build_skiff, 'hauler': build_hauler, 'seed': build_seed, 'drone': build_drone, 'mech': build_mech, 'frame': build_frame,
            'station': build_station, 'junk': build_junk}
only = [a for a in argv[2:]] or list(BUILDERS)
for name in only:
    reset()
    BUILDERS[name]()
    export(name)
    preview(name)
print('DONE')
