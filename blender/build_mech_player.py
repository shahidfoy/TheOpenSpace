"""Skinned mechs, armed with a long sword and animated with the katana-pack, Mixamo and Noir sword clips retargeted
onto their skeletons. Two source models (--src):
  nexorion  the player suit (default): "NEXORION // The Neon Vanguard" by Atahan3D (Sketchfab, CC-BY 4.0). One
            watertight sculpt with no skeleton: a skeleton is placed from measured joint positions and every vertex is
            weighted by distance to the bones of the body region it is surface-connected to (see nexorion_weights).
  jsdf      the arena enemies (default with --lod): "JSDF MECHA" by Kussa (Sketchfab, CC-BY 4.0), rigidly re-skinned.
Writes public/models/mech_player.glb + mech_player.json (mech_enemy.* with --lod).

Run:  blender --background --factory-startup --python blender/build_mech_player.py -- [out.glb] [--src=nexorion|jsdf]
      [--clips=a,b] [--preview=dir]
Assets come from MECH_ASSETS (default D:\\TAMAMO\\game-assets): mech/sketchfab/{nexorion,jsdf}, mech/katana,
mech/mixamo, noir/arena/anims.

The JSDF build:

The model: 187 hard-surface parts hung on a skeleton through empties. Its armature rest pose is meaningless (every
part collapses onto the spear); only the posed stance is valid. So the stance becomes the rest: each part's posed
world matrix is baked into its vertices, the pose is applied as rest, and every part is weighted 1.0 to the bone it
hung from. All parts are joined per material (one skinned mesh, ~5 draw calls). The spear is removed and a sword is
modelled in the right fist along a 'katana_grip' bone. Image textures (tiling rust noise) are dropped: the game
paints the materials (Main_Color = armour, Secondary_Color = frame, Light = lamps, mech_blade / mech_blade_edge).

Retargeting (ported from Noir's tools/retarget_heroine.py): every rig is matched to a canonical joint set. Joint
frames are rebuilt from joint positions; limbs and torso get the source frame's ABSOLUTE orientation (the stance rest
is far from a T-pose), feet get the source's change since its rest (this rig's ankle -> sole bone points down, not
forward). Hips translation is scaled by leg length. Only mapped joints are keyed; fenders, actuators and the shoulder
binders stay rest-relative to their parents.

mech_player.json: per clip, duration and the detected blade swings (time window, arc plane, reach in glTF space,
character facing +Z), from which the game builds hit windows and slash crescents. 'height' is the rest height, 'blade'
the sword's length; both in model units.
"""
import bpy, bmesh, sys, os, json, re, math
import numpy as np
from mathutils import Matrix, Vector

ROOT = os.environ.get('MECH_ASSETS', r'D:\TAMAMO\game-assets')
MECH = os.path.join(ROOT, 'mech')
KC = os.path.join(MECH, 'katana', 'In_Place')
MX = os.path.join(MECH, 'mixamo')
NA = os.path.join(ROOT, 'noir', 'arena', 'anims')

argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
opt = {a.split('=')[0][2:]: (a.split('=', 1)[1] if '=' in a else True) for a in argv if a.startswith('--')}
pos = [a for a in argv if not a.startswith('--')]
# --lod: the arena enemies' build (30k triangles, only the clips the enemy AI plays) -> mech_enemy.glb
LOD = 'lod' in opt
SRC_KIND = str(opt.get('src', 'jsdf' if LOD else 'nexorion'))
SRC = os.path.join(MECH, 'sketchfab', SRC_KIND, f'{SRC_KIND}.glb')
OUT = os.path.abspath(pos[0] if pos else ('public/models/mech_enemy.glb' if LOD else 'public/models/mech_player.glb'))
ONLY = [c for c in str(opt.get('clips', '')).split(',') if c and c != 'True']
PREVIEW = opt.get('preview')
FPS = 30

CLIPS = {
    # locomotion
    'idle': f'{KC}/AS_Anime_KC_Idle.fbx',
    'ss_idle': f'{MX}/Sword And Shield Idle.fbx',
    'walk': f'{MX}/Walking.fbx',
    'walk_l': f'{MX}/Left Strafe Walking.fbx',
    'walk_r': f'{MX}/Right Strafe Walking.fbx',
    'walk_b': f'{MX}/Walking Backwards.fbx',
    'run': f'{KC}/AS_Anime_KC_Run.fbx',
    'sprint': f'{NA}/Sprint.fbx',
    'turn_l': f'{MX}/Standing Turn Left 90.fbx',
    'turn_r': f'{MX}/Standing Turn Right 90.fbx',
    'jump': f'{KC}/AS_Anime_KC_Jump.fbx',
    'fall': f'{MX}/Falling Idle.fbx',
    'land': f'{MX}/Hard Landing.fbx',
    'dash': f'{KC}/AS_Anime_KC_Dash.fbx',
    'dodge': f'{KC}/AS_Anime_KC_Dodge_V1.fbx',
    'dodge2': f'{KC}/AS_Anime_KC_Dodge_V2.fbx',
    # defence / reactions
    'block': f'{KC}/AS_Anime_KC_Block_01.fbx',
    'block_hit': f'{KC}/AS_Anime_KC_Block_01_Hit.fbx',
    'hit': f'{KC}/AS_Anime_KC_Get_Hit_V1.fbx',
    'hit2': f'{KC}/AS_Anime_KC_Get_Hit_V2.fbx',
    'big_hit': f'{MX}/Big Stomach Hit.fbx',
    'knockdown': f'{NA}/Livershot Knockdown.fbx',
    'getup': f'{NA}/Getting Up.fbx',
    'death': f'{NA}/Dying Backwards.fbx',
    # sword
    'combo1': f'{KC}/AS_Anime_KC_Combo_V1.fbx',
    'combo2': f'{KC}/AS_Anime_KC_Combo_V2.fbx',
    'strikes': f'{KC}/AS_Anime_KC_Strikes.fbx',
    'double_slash': f'{KC}/AS_Anime_KC_Double_Slash.fbx',
    'charge': f'{KC}/AS_Anime_KC_Charge_Attack.fbx',
    'aerial': f'{KC}/AS_Anime_KC_Combo_Aerial.fbx',
    'combo_down': f'{KC}/AS_Anime_KC_Combo_Down.fbx',
    'circle': f'{KC}/AS_Anime_KC_Circle.fbx',
    'jump_attack': f'{KC}/AS_Anime_KC_Jump_Attack_V2.fbx',
    'thrust': f'{KC}/AS_Anime_KC_Thrust.fbx',
    'gs_slash': f'{NA}/Great Sword Slash.fbx',
    'sw_inward': f'{NA}/Stable Sword Inward Slash.fbx',
    'sw_outward': f'{NA}/Stable Sword Outward Slash.fbx',
}
ENEMY_CLIPS = ['idle', 'walk', 'walk_l', 'walk_r', 'walk_b', 'run', 'fall', 'dash', 'dodge', 'block', 'hit', 'hit2', 'big_hit',
               'knockdown', 'getup', 'death', 'combo1', 'sw_inward', 'sw_outward', 'gs_slash', 'charge', 'combo_down', 'aerial',
               'circle', 'thrust']
LOOPS = ['idle', 'ss_idle', 'walk', 'walk_l', 'walk_r', 'walk_b', 'run', 'sprint', 'fall']

# ---------------------------------------------------------------- canonical joints
J = lambda s: rf'{s}_\d+'          # JSDF bone names end in _<index>
CANON = {  # order matters: earlier joints claim bones first
    'hips': [r'pelvis', r'hips', J('Hip')],
    'chest': [r'spine_05', r'spine2', J('Chest')],
    'spine': [r'spine_03', r'spine1'],
    'neck': [r'neck_01', r'neck', J('Head')],      # JSDF has no neck: its head joint plays the neck
    'head': [r'head'],
}
for s, S in (('l', 'Left'), ('r', 'Right')):
    X = s.upper()
    CANON[f'clav_{s}'] = [rf'clavicle_{s}', rf'{S}Shoulder']
    CANON[f'arm_{s}'] = [rf'upperarm_{s}', rf'{S}Arm', J(rf'Upper_Arm\.{X}')]
    CANON[f'fore_{s}'] = [rf'lowerarm_{s}', rf'{S}ForeArm', J(rf'Lower_Arm\.{X}')]
    CANON[f'hand_{s}'] = [rf'hand_{s}', rf'{S}Hand', J(rf'Lower_Arm\.{X}\.001')]
    CANON[f'thigh_{s}'] = [rf'thigh_{s}', rf'{S}UpLeg', J(rf'Upper_Leg\.{X}')]
    CANON[f'shin_{s}'] = [rf'calf_{s}', rf'{S}Leg', J(rf'Lower_leg\.{X}')]
    CANON[f'foot_{s}'] = [rf'foot_{s}', rf'{S}Foot', J(rf'Upper_Foot\.{X}')]
    CANON[f'toe_{s}'] = [rf'ball_{s}', rf'{S}ToeBase', J(rf'Lower_Foot\.{X}')]
    # JSDF fingers: 4 = index (next to the thumb), 3 middle, 2 ring, 1 little, 5 thumb; 7 segments each, 1/3/5 used
    for f, ue, mx, n in (('index', 'index', 'Index', 4), ('mid', 'middle', 'Middle', 3), ('ring', 'ring', 'Ring', 2),
                         ('little', 'pinky', 'Pinky', 1), ('thumb', 'thumb', 'Thumb', 5)):
        for k in (1, 2, 3):
            CANON[f'{f}{k}_{s}'] = [rf'{ue}_0{k}_{s}', rf'{S}Hand{mx}{k}', J(rf'{n}_{2 * k - 1}_Finger\.{X}')]

REL = {'foot_l', 'foot_r'}          # joints transferred rest-relative; everything else absolute
CHILD = {}
for s in 'lr':
    for f in ('index', 'mid', 'ring', 'little', 'thumb'):
        CHILD[f'{f}1_{s}'] = f'{f}2_{s}'; CHILD[f'{f}2_{s}'] = f'{f}3_{s}'


def resolve(arm):
    plain = {(re.sub(r'_\d+$', '', re.sub(r'^mixamorig\d*:', '', n)) if n.startswith('mixamorig') else n): n
             for n in (b.name for b in arm.data.bones)}
    out, used = {}, set()
    for c, pats in CANON.items():
        for p in pats:
            hit = next((orig for pn, orig in plain.items() if orig not in used and re.fullmatch(p, pn, re.I)), None)
            if hit: out[c] = hit; used.add(hit); break
    return out


def wrot(obj, m):
    return (obj.matrix_world.to_quaternion() @ m.to_quaternion()).normalized()


def assign(obj, act):
    if not obj.animation_data: obj.animation_data_create()
    obj.animation_data.action = act
    if hasattr(obj.animation_data, 'action_slot') and act and act.slots:
        obj.animation_data.action_slot = act.slots[0]


# ---------------------------------------------------------------- target
def bone_of(o):
    while o is not None:
        if o.parent_type == 'BONE' and o.parent_bone: return o.parent_bone
        o = o.parent
    return None


def ancestors(o):
    out = []
    while o is not None: out.append(o.name); o = o.parent
    return out


def new_mat(name, rgb, metal, rough, emit=None):
    m = bpy.data.materials.new(name); m.use_nodes = True
    b = m.node_tree.nodes['Principled BSDF']
    b.inputs['Base Color'].default_value = (*rgb, 1)
    b.inputs['Metallic'].default_value = metal; b.inputs['Roughness'].default_value = rough
    if emit:
        b.inputs['Emission Color'].default_value = (*emit, 1); b.inputs['Emission Strength'].default_value = 3.0
    return m


def build_sword(arm, grip_name, hand_bone, H):
    """Long sword in grip space (+Y along the blade, +X = edge): hilt, guard, a broad blade with a raised spine, a
    clipped tip and a glowing edge inlay. Weighted to the hand bone."""
    bm = bmesh.new()
    L = 0.52 * H                 # blade length
    W = 0.055 * H                # blade half-width at the guard
    T = 0.012 * H                # half-thickness at the spine
    hilt = 0.11 * H

    def ring(y, w, t, e=0.25):   # cross-section: elongated hexagon (edge, bevel, spine, bevel, edge, ...)
        return [Vector((w, y, 0)), Vector((w * (1 - e), y, t)), Vector((-w * (1 - e), y, t)), Vector((-w, y, 0)),
                Vector((-w * (1 - e), y, -t)), Vector((w * (1 - e), y, -t))]

    def loft(sections, cap0=True, cap1=True, mat=0):
        rings = [[bm.verts.new(v) for v in sec] for sec in sections]
        for a, b in zip(rings, rings[1:]):
            n = len(a)
            for i in range(n):
                f = bm.faces.new((a[i], a[(i + 1) % n], b[(i + 1) % n], b[i])); f.material_index = mat
        if cap0: f = bm.faces.new(list(reversed(rings[0]))); f.material_index = mat
        if cap1: f = bm.faces.new(rings[-1]); f.material_index = mat
        return rings

    # blade: base -> shoulder -> clipped tip (asymmetric, like a tanto/greatsword hybrid)
    secs = [ring(0.02 * H, W * 0.9, T), ring(0.06 * H, W, T), ring(L * 0.55, W * 0.92, T * 0.9), ring(L * 0.84, W * 0.8, T * 0.75)]
    loft(secs, cap1=False, mat=0)
    tip = bm.verts.new(Vector((W * 0.55, L, 0)))
    last = [v for v in bm.verts if abs(v.co.y - L * 0.84) < 1e-6]
    last.sort(key=lambda v: math.atan2(v.co.z, v.co.x))
    for i in range(len(last)):
        f = bm.faces.new((last[i], last[(i + 1) % len(last)], tip)); f.material_index = 0
    # edge inlay: thin glowing strip along the cutting edge (+X)
    loft([[Vector((W * 1.01, y, T * 0.12)), Vector((W * 1.01, y, -T * 0.12)), Vector((W * 0.86, y, -T * 0.3)), Vector((W * 0.86, y, T * 0.3))]
          for y in (0.07 * H, L * 0.8)], mat=1)
    # guard: chunky block with swept wings
    loft([ring(-0.005 * H, W * 1.55, T * 2.6, 0.4), ring(0.03 * H, W * 1.75, T * 2.2, 0.45)], mat=2)
    # hilt + pommel
    loft([ring(-hilt, W * 0.3, T * 1.6, 0.5), ring(-0.005 * H, W * 0.32, T * 1.7, 0.5)], mat=3)
    loft([ring(-hilt - 0.03 * H, W * 0.42, T * 2.0, 0.5), ring(-hilt, W * 0.45, T * 2.2, 0.5)], mat=2)
    me = bpy.data.meshes.new('sword'); bm.to_mesh(me); bm.free()
    for poly in me.polygons: poly.use_smooth = False
    ob = bpy.data.objects.new('sword', me); bpy.context.scene.collection.objects.link(ob)
    for m in (new_mat('mech_blade', (0.78, 0.8, 0.82), 1.0, 0.18), new_mat('mech_blade_edge', (0.1, 0.1, 0.1), 0.0, 0.4, (0.35, 0.9, 1.0)),
              new_mat('Secondary_Color', (0.1, 0.1, 0.12), 0.8, 0.4), new_mat('Secondary_Color', (0.05, 0.05, 0.06), 0.4, 0.7)):
        me.materials.append(m)
    me.materials[2] = bpy.data.materials['Secondary_Color']
    me.materials[3] = bpy.data.materials['Secondary_Color']
    gb = arm.data.bones[grip_name]
    ob.matrix_world = arm.matrix_world @ gb.matrix_local
    return ob, L


# Paint zones for the customisable livery. JSDF has ~20 main armour pieces; they're split by the bone they hang on:
#   paint_a  main colour: shoulders, upper / lower arms, thighs, shins, head
#   paint_b  second colour: chest core
#   paint_c  trim: waist, feet, shoulder binders
#   hands + fingers go to the dark frame (Secondary_Color); Light stays the lamps.
ZONES = [('frame', re.compile(r'^(\d_\d_Finger|Lower_Arm\.[LR]\.001)')), ('b', re.compile(r'^Chest_')),
         ('c', re.compile(r'^(Hip_|Upper_Foot|Lower_Foot|Upper_Actuater|Lower_Actuater)'))]


def paint_zones(parts, H):
    mats = {z: new_mat(f'paint_{z}', rgb, 0.3, 0.45) for z, rgb in (('a', (0.85, 0.86, 0.88)), ('b', (0.05, 0.12, 0.45)), ('c', (0.6, 0.05, 0.04)))}
    mats['frame'] = bpy.data.materials['Secondary_Color']
    count = {'a': 0, 'b': 0, 'c': 0, 'frame': 0}
    for o, b, _ in parts:
        if o.data.users > 1: o.data = o.data.copy()      # mirrored parts share mesh data; paint each on its own
        z = next((z for z, rx in ZONES if rx.match(b)), 'a')
        for s in o.material_slots:
            if s.material and s.material.name.startswith('Main_Color'):
                s.material = mats[z]; count[z] += 1
    print('[zones]', count)


def prep_target():
    return prep_nexorion() if SRC_KIND == 'nexorion' else prep_jsdf()


# ---------------------------------------------------------------- NEXORION
# Joint heads in the source model's units (1.9 tall, facing -Y, left = +X), measured from horizontal slices of the
# mesh (limb cross-section centres) and its front / side silhouettes. Bone names follow Mixamo so resolve() maps them.
NX_CORE = {'Hips': ((0, 0, 0.04), None), 'Spine1': ((0, 0, 0.22), 'Hips'), 'Spine2': ((0, -0.01, 0.42), 'Spine1'),
           'Neck': ((0, 0, 0.68), 'Spine2'), 'Head': ((0, -0.01, 0.76), 'Neck')}
NX_SIDE = {'Shoulder': ((0.05, -0.01, 0.62), 'Spine2'), 'Arm': ((0.27, -0.03, 0.59), 'Shoulder'),
           'ForeArm': ((0.36, -0.03, 0.30), 'Arm'), 'Hand': ((0.385, -0.115, 0.125), 'ForeArm'),
           'UpLeg': ((0.12, 0, -0.02), 'Hips'), 'Leg': ((0.20, -0.03, -0.40), 'UpLeg'),
           'Foot': ((0.24, 0, -0.82), 'Leg'), 'ToeBase': ((0.25, -0.13, -0.92), 'Foot')}
NX_CHILD = {'Hips': 'Spine1', 'Spine1': 'Spine2', 'Spine2': 'Neck', 'Neck': 'Head', 'Shoulder': 'Arm', 'Arm': 'ForeArm',
            'ForeArm': 'Hand', 'UpLeg': 'Leg', 'Leg': 'Foot', 'Foot': 'ToeBase'}
NX_TIP = {'Head': (0, -0.01, 0.93), 'Hand': (0.39, -0.15, -0.05), 'ToeBase': (0.25, -0.235, -0.93)}


def nexorion_weights(ob, bones):
    """Per-vertex skin weights in source units. Each vertex gets a body region and may only follow that region's
    bones: an arm is everything surface-connected to its hand beyond the armpit plane (so the hip plates the hands
    hang beside stay on the hips), legs are below the hip joints, the front tabard and the back crystal shards are
    pinned to the hips, the rest is torso. Within a region the weights fall off with distance to each bone segment,
    then get two passes of neighbour smoothing so the joints bend instead of tearing."""
    me = ob.data
    n = len(me.vertices)
    co = np.empty(n * 3); me.vertices.foreach_get('co', co); co = co.reshape(-1, 3)
    ev = np.empty(len(me.edges) * 2, np.int64); me.edges.foreach_get('vertices', ev); ev = ev.reshape(-1, 2)
    names = list(bones)
    ix = {b: i for i, b in enumerate(names)}
    D = np.empty((n, len(names)))
    for i, b in enumerate(names):
        a, t = (np.array(v[:]) for v in bones[b])
        ab = t - a
        u = np.clip(((co - a) @ ab) / (ab @ ab), 0, 1)
        D[:, i] = np.linalg.norm(co - (a + u[:, None] * ab), axis=1)
    x, y, z = co.T
    src, dst = np.concatenate([ev[:, 0], ev[:, 1]]), np.concatenate([ev[:, 1], ev[:, 0]])
    o = np.argsort(src, kind='stable'); src, dst = src[o], dst[o]
    start = np.searchsorted(src, np.arange(n + 1))

    allow = np.zeros((n, len(names)), bool)
    arm_any = np.zeros(n, bool)
    for s, sg in (('Left', 1), ('Right', -1)):
        ok = (sg * x > 0.235) & (z > -0.13)
        seen = ok & (sg * x > 0.3) & (D[:, ix[s + 'Hand']] < 0.06)
        stack = list(np.nonzero(seen)[0])
        while stack:
            v = stack.pop()
            for w in dst[start[v]:start[v + 1]]:
                if ok[w] and not seen[w]: seen[w] = True; stack.append(w)
        for b in ('Shoulder', 'Arm', 'ForeArm', 'Hand'): allow[seen, ix[s + b]] = True
        allow[seen, ix['Spine2']] = True
        arm_any |= seen
    rigid = ((np.abs(x) < 0.09) & (y < -0.12) & (z > -0.36) & (z < 0.05)) | ((y > 0.14) & (z > -0.6) & (z < 0.0))
    rigid &= ~arm_any
    leg = (z < -0.02) & ~arm_any & ~rigid
    torso = ~arm_any & ~rigid & ~leg
    for s, sg in (('Left', 1), ('Right', -1)):
        m = leg & (sg * x >= 0)
        for b in ('UpLeg', 'Leg', 'Foot', 'ToeBase'): allow[m, ix[s + b]] = True
        allow[m, ix['Hips']] = True
        allow[torso & (sg * x > 0.12), ix[s + 'Shoulder']] = True
    for b in ('Hips', 'Spine1', 'Spine2', 'Neck', 'Head'): allow[torso, ix[b]] = True
    allow[rigid, ix['Hips']] = True

    Dm = np.where(allow, D, np.inf)
    W = np.exp(-(Dm - Dm.min(axis=1, keepdims=True)) / 0.025)
    for _ in range(2):
        acc = np.zeros_like(W); cnt = np.zeros(n)
        np.add.at(acc, ev[:, 0], W[ev[:, 1]]); np.add.at(acc, ev[:, 1], W[ev[:, 0]])
        np.add.at(cnt, ev[:, 0], 1); np.add.at(cnt, ev[:, 1], 1)
        W = 0.5 * W + 0.5 * acc / np.maximum(cnt, 1)[:, None]
    W[rigid] = 0; W[rigid, ix['Hips']] = 1
    keep = np.argsort(-W, axis=1)[:, :4]
    Wk = np.take_along_axis(W, keep, axis=1)
    Wk[Wk < 0.02] = 0
    Wk /= Wk.sum(axis=1, keepdims=True)
    groups = {b: ob.vertex_groups.new(name=b) for b in names}
    for v in range(n):
        for k in range(4):
            if Wk[v, k] > 0: groups[names[keep[v, k]]].add([v], float(Wk[v, k]), 'REPLACE')
    print(f'[weights] arms {arm_any.sum()} legs {leg.sum()} torso {torso.sum()} pinned {rigid.sum()} of {n}')


def prep_nexorion():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.context.scene.render.fps = FPS
    bpy.ops.import_scene.gltf(filepath=SRC)
    ms = [o for o in bpy.data.objects if o.type == 'MESH']
    for o in ms:
        mw = o.matrix_world.copy(); o.parent = None; o.matrix_world = mw
    for o in [o for o in bpy.data.objects if o.type != 'MESH']: bpy.data.objects.remove(o, do_unlink=True)
    bpy.ops.object.select_all(action='DESELECT')
    for o in ms: o.select_set(True)
    body = ms[0]
    bpy.context.view_layer.objects.active = body
    bpy.ops.object.join()
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    body.name = 'mech_body'
    body.material_slots[0].material.name = 'suit'

    # weld the glTF seam splits, then collapse the 1M-triangle sculpt to the budget (the normal map keeps the detail)
    bm = bmesh.new(); bm.from_mesh(body.data)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-4)
    bm.to_mesh(body.data); bm.free()
    if body.data.has_custom_normals:
        with bpy.context.temp_override(object=body, active_object=body):
            bpy.ops.mesh.customdata_custom_splitnormals_clear()
    f0 = sum(len(p.vertices) - 2 for p in body.data.polygons)
    budget = 40000 if LOD else 120000
    d = body.modifiers.new('collapse', 'DECIMATE'); d.decimate_type = 'COLLAPSE'; d.ratio = min(1.0, budget / f0)
    d.use_collapse_triangulate = True
    bpy.ops.object.modifier_apply(modifier='collapse')
    body.data.shade_smooth()
    print(f'[decimate] {f0} -> {sum(len(p.vertices) - 2 for p in body.data.polygons)} tris')

    # skeleton
    arm = bpy.data.objects.new('rig', bpy.data.armatures.new('rig'))
    bpy.context.scene.collection.objects.link(arm)
    bpy.ops.object.select_all(action='DESELECT')
    bpy.context.view_layer.objects.active = arm
    bpy.ops.object.mode_set(mode='EDIT')
    heads, parents = {}, {}
    for nm, (h, p) in NX_CORE.items(): heads[nm], parents[nm] = Vector(h), p
    for s, sg in (('Left', 1), ('Right', -1)):
        for nm, (h, p) in NX_SIDE.items():
            heads[s + nm] = Vector((sg * h[0], h[1], h[2]))
            parents[s + nm] = s + p if p in NX_SIDE else p
    eb = arm.data.edit_bones
    for nm, h in heads.items():
        s = 'Left' if nm.startswith('Left') else 'Right' if nm.startswith('Right') else ''
        base = nm[len(s):]
        b = eb.new(nm); b.head = h
        if base in NX_CHILD: b.tail = heads[s + NX_CHILD[base]]
        else: t = NX_TIP[base]; b.tail = Vector(((-1 if s == 'Right' else 1) * t[0], t[1], t[2]))
    for nm, p in parents.items():
        if p: eb[nm].parent = eb[p]
    bpy.ops.object.mode_set(mode='OBJECT')
    nexorion_weights(body, {b.name: (b.head_local.copy(), b.tail_local.copy()) for b in arm.data.bones})

    # stand it on the ground, centred on the hips, scaled to 6 units like the JSDF build
    lo = min((body.matrix_world @ Vector(c)).z for c in body.bound_box)
    hi = max((body.matrix_world @ Vector(c)).z for c in body.bound_box)
    hips0 = heads['Hips']
    fix = Matrix.Scale(6.0 / (hi - lo), 4) @ Matrix.Translation(Vector((-hips0.x, -hips0.y, -lo)))
    for o in (arm, body): o.matrix_world = fix @ o.matrix_world
    bpy.ops.object.select_all(action='DESELECT')
    arm.select_set(True); body.select_set(True)
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    H = 6.0

    # sword grip in the right palm: +Y along the blade, pointing forward out of the hanging hand
    bpy.ops.object.select_all(action='DESELECT')
    bpy.context.view_layer.objects.active = arm
    bpy.ops.object.mode_set(mode='EDIT')
    eb = arm.data.edit_bones
    hand = eb['RightHand']
    fwd = (hand.tail - hand.head).normalized()
    blade = Vector((0, -1, 0)); blade = (blade - fwd * blade.dot(fwd)).normalized()
    grip = eb.new('katana_grip')
    grip.head = hand.head.lerp(hand.tail, 0.45)
    grip.tail = grip.head + blade * (hand.tail - hand.head).length * 0.5
    grip.align_roll(fwd)
    grip.parent = hand
    grip.use_deform = False
    bpy.ops.object.mode_set(mode='OBJECT')

    sword, L = build_sword(arm, 'katana_grip', 'RightHand', H)
    bpy.ops.object.select_all(action='DESELECT')
    sword.select_set(True); bpy.context.view_layer.objects.active = sword
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    sword.vertex_groups.new(name='RightHand').add(list(range(len(sword.data.vertices))), 1.0, 'REPLACE')
    body.select_set(True); bpy.context.view_layer.objects.active = body
    bpy.ops.object.join()
    mod = body.modifiers.new('Armature', 'ARMATURE'); mod.object = arm
    body.parent = arm

    meta = {'height': round(H, 3), 'blade': round(L, 3)}
    print(f'[target] nexorion: {len(body.data.polygons)} faces, {len(arm.data.bones)} bones, mats {[s.material.name for s in body.material_slots]}, blade {L:.2f}')
    return arm, meta


# ---------------------------------------------------------------- JSDF
def prep_jsdf():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scn = bpy.context.scene
    scn.render.fps = FPS
    bpy.ops.import_scene.gltf(filepath=SRC)
    arm = next(o for o in bpy.data.objects if o.type == 'ARMATURE')
    hand_r = next(b.name for b in arm.data.bones if re.fullmatch(J(r'Lower_Arm\.R\.001'), b.name))

    # parts: posed world matrix + owning bone; drop the spear (shaft Cylinder.013 and everything hung on it)
    parts = []
    for o in list(bpy.data.objects):
        if o.type != 'MESH': continue
        b = bone_of(o)
        if b is None or any(n.startswith('Cylinder.013') for n in ancestors(o)):
            bpy.data.objects.remove(o, do_unlink=True); continue
        parts.append((o, b, o.matrix_world.copy()))
    for o, b, mw in parts:
        o.parent = None; o.matrix_world = mw
    # the stance becomes the rest pose, then the armature sheds the Sketchfab node transforms
    bpy.context.view_layer.objects.active = arm
    arm.select_set(True)
    bpy.ops.object.mode_set(mode='POSE')
    bpy.ops.pose.select_all(action='SELECT')
    bpy.ops.pose.armature_apply(selected=False)
    bpy.ops.object.mode_set(mode='OBJECT')
    mw = arm.matrix_world.copy(); arm.parent = None; arm.matrix_world = mw
    for o in [o for o in bpy.data.objects if o.type == 'EMPTY']: bpy.data.objects.remove(o, do_unlink=True)
    bpy.ops.object.select_all(action='DESELECT')
    arm.select_set(True)
    for o, _, _ in parts: o.select_set(True)
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    for pb in arm.pose.bones:
        for c in list(pb.constraints): pb.constraints.remove(c)
        pb.matrix_basis = Matrix.Identity(4); pb.rotation_mode = 'QUATERNION'

    # stand it on the ground, centred, facing -Y (Blender front); scale to ~6 units
    zs = [(o.matrix_world @ Vector(c)) for o, _, _ in parts for c in o.bound_box]
    lo = Vector((min(v.x for v in zs), min(v.y for v in zs), min(v.z for v in zs)))
    hi = Vector((max(v.x for v in zs), max(v.y for v in zs), max(v.z for v in zs)))
    tmap = resolve(arm)
    hips0 = arm.matrix_world @ arm.data.bones[tmap['hips']].head_local
    k = 6.0 / (hi.z - lo.z)
    fix = Matrix.Scale(k, 4) @ Matrix.Translation(Vector((-hips0.x, -hips0.y, -lo.z)))
    for o in [arm] + [p[0] for p in parts]:
        o.matrix_world = fix @ o.matrix_world
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)

    # katana grip bone in the right fist (Noir's add_grip): +Y out of the fist on the thumb side
    bpy.ops.object.mode_set(mode='EDIT')
    eb = arm.data.edit_bones
    fb = lambda n: next(b for b in eb if re.fullmatch(J(n), b.name))
    wrist = eb[hand_r]
    idx, mid, ring, lit = fb(r'4_1_Finger\.R'), fb(r'3_1_Finger\.R'), fb(r'2_1_Finger\.R'), fb(r'1_1_Finger\.R')
    knuckle = (idx.head + mid.head + ring.head + lit.head) / 4
    fwd = (knuckle - wrist.head).normalized()
    blade = (idx.head - lit.head).normalized()
    blade = (blade - fwd * blade.dot(fwd)).normalized()
    grip = eb.new('katana_grip')
    grip.head = wrist.head.lerp(knuckle, 0.75)
    grip.tail = grip.head + blade * (knuckle - wrist.head).length
    grip.align_roll(fwd)
    grip.parent = wrist
    grip.use_deform = False
    bpy.ops.object.mode_set(mode='OBJECT')

    zs = [(o.matrix_world @ Vector(c)).z for o, _, _ in parts for c in o.bound_box]
    H = max(zs) - min(zs)
    paint_zones(parts, H)
    sword, L = build_sword(arm, 'katana_grip', hand_r, H)
    parts.append((sword, hand_r, sword.matrix_world.copy()))

    # rigid skin: every part weighted 1.0 to its bone, then joined into one mesh (one primitive per material)
    for o, b, _ in parts:
        bpy.ops.object.select_all(action='DESELECT'); o.select_set(True); bpy.context.view_layer.objects.active = o
        bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
        for g in list(o.vertex_groups): o.vertex_groups.remove(g)
        vg = o.vertex_groups.new(name=b)
        vg.add(list(range(len(o.data.vertices))), 1.0, 'REPLACE')
    bpy.ops.object.select_all(action='DESELECT')
    for o, _, _ in parts: o.select_set(True)
    body = parts[0][0]
    bpy.context.view_layer.objects.active = body
    bpy.ops.object.join()
    body.name = 'mech_body'
    # merge duplicate materials (Main_Color_With_logo* are plain Main_Color) into one slot each
    first = {}
    remap = []
    for i, s in enumerate(body.material_slots):
        n = re.sub(r'_With_logo.*|\.\d+$', '', s.material.name)
        if n in bpy.data.materials: s.material = bpy.data.materials[n]
        remap.append(first.setdefault(s.material.name, i))
    for poly in body.data.polygons: poly.material_index = remap[poly.material_index]
    bpy.ops.object.select_all(action='DESELECT'); body.select_set(True); bpy.context.view_layer.objects.active = body
    bpy.ops.object.material_slot_remove_unused()
    for m in bpy.data.materials:
        if m.node_tree:
            for nd in list(m.node_tree.nodes):
                if nd.type == 'TEX_IMAGE': m.node_tree.nodes.remove(nd)
    for img in list(bpy.data.images): bpy.data.images.remove(img)
    # decimate: merge near-coplanar faces first (lossless on hard surfaces), then collapse down to the budget
    f0 = sum(len(p.vertices) - 2 for p in body.data.polygons)
    d = body.modifiers.new('planar', 'DECIMATE'); d.decimate_type = 'DISSOLVE'; d.angle_limit = math.radians(2.0)
    d.delimit = {'MATERIAL', 'SHARP'}
    bpy.ops.object.modifier_apply(modifier='planar')
    tris = sum(len(p.vertices) - 2 for p in body.data.polygons)
    BUDGET = 30000 if LOD else 90000
    if tris > BUDGET:
        d = body.modifiers.new('collapse', 'DECIMATE'); d.decimate_type = 'COLLAPSE'; d.ratio = BUDGET / tris
        d.use_collapse_triangulate = True
        bpy.ops.object.modifier_apply(modifier='collapse')
    print(f'[decimate] {f0} -> {sum(len(p.vertices) - 2 for p in body.data.polygons)} tris')
    mod = body.modifiers.new('Armature', 'ARMATURE'); mod.object = arm
    body.parent = arm

    meta = {'height': round(H, 3), 'blade': round(L, 3)}
    print(f'[target] {len(parts)} parts -> 1 mesh, {len(body.data.polygons)} faces, mats {[s.material.name for s in body.material_slots]}, height {H:.2f}, blade {L:.2f}')
    return arm, meta


# ---------------------------------------------------------------- sources
def load_source(path):
    before = set(bpy.data.objects); acts_before = set(bpy.data.actions)
    bpy.ops.import_scene.fbx(filepath=path, use_anim=True)
    new = [o for o in bpy.data.objects if o not in before]
    new_acts = [a for a in bpy.data.actions if a not in acts_before]
    src = next(o for o in new if o.type == 'ARMATURE')
    act = max(new_acts, key=lambda a: a.frame_range[1] - a.frame_range[0])

    def cleanup():
        for o in new:
            if o.name in bpy.data.objects: bpy.data.objects.remove(o, do_unlink=True)
        for a in new_acts:
            if a.name in bpy.data.actions: bpy.data.actions.remove(a)
        for blk in (bpy.data.meshes, bpy.data.materials, bpy.data.images, bpy.data.armatures):
            for d in list(blk):
                if d.users == 0: blk.remove(d)
    return src, act, cleanup


def retarget(tgt, clip, path):
    src, act, cleanup = load_source(path)
    try:
        return _retarget(tgt, clip, src, act)
    finally:
        cleanup()


def _retarget(tgt, clip, src, act):
    scn = bpy.context.scene
    assign(src, act)
    smap, tmap = resolve(src), resolve(tgt)
    joints = [c for c in CANON if c in smap and c in tmap]
    missing = [c for c in ('hips', 'chest', 'neck', 'arm_r', 'fore_r', 'hand_r', 'thigh_l', 'shin_l', 'foot_l', 'toe_l') if c not in joints]
    if missing: raise RuntimeError(f'{clip}: unmapped joints {missing}; src {list(smap)} tgt {list(tmap)}')
    fingers = [j for j in joints if re.match(r'(index|mid|ring|little|thumb)\d', j)]

    def positions(obj, m, posed):
        return {j: obj.matrix_world @ (obj.pose.bones[m[j]].head if posed else obj.data.bones[m[j]].head_local) for j in joints}

    def frames(P):
        F = {}
        side_hips = P['thigh_l'] - P['thigh_r']
        side_chest = (P['arm_l'] - P['arm_r']) if 'arm_l' in P else side_hips
        up_chest = P['neck'] - P['chest']
        fwd_chest = side_chest.cross(up_chest)

        def mk(j, y, h, fallback=None):
            y = y.normalized()
            x = h - y * h.dot(y)
            if x.length < 1e-4 * max(h.length, 1e-6) or (fallback is not None and x.length < 0.25 * h.length):
                h = fallback if fallback is not None else Vector((1, 0, 0))
                x = h - y * h.dot(y)
            x.normalize()
            F[j] = Matrix((x, y, x.cross(y))).transposed().to_quaternion()
        mk('hips', P.get('spine', P['chest']) - P['hips'], side_hips)
        if 'spine' in P: mk('spine', P['chest'] - P['spine'], side_hips + side_chest)
        mk('chest', P['neck'] - P['chest'], side_chest)
        if 'head' in P: mk('neck', P['head'] - P['neck'], side_chest)
        for s in 'lr':
            if f'arm_{s}' not in P: continue
            knuck = (P[f'index1_{s}'] - P[f'little1_{s}']) if f'index1_{s}' in P and f'little1_{s}' in P else fwd_chest
            if f'clav_{s}' in P: mk(f'clav_{s}', P[f'arm_{s}'] - P[f'clav_{s}'], up_chest)
            mk(f'arm_{s}', P[f'fore_{s}'] - P[f'arm_{s}'], P[f'hand_{s}'] - P[f'fore_{s}'], fallback=fwd_chest)
            mk(f'fore_{s}', P[f'hand_{s}'] - P[f'fore_{s}'], knuck)
            tip = P.get(f'mid1_{s}', P[f'hand_{s}'] + (P[f'hand_{s}'] - P[f'fore_{s}']))
            mk(f'hand_{s}', tip - P[f'hand_{s}'], knuck)
            footfwd = P[f'toe_{s}'] - P[f'foot_{s}']
            mk(f'thigh_{s}', P[f'shin_{s}'] - P[f'thigh_{s}'], side_hips, fallback=fwd_chest)
            mk(f'shin_{s}', P[f'foot_{s}'] - P[f'shin_{s}'], side_hips, fallback=fwd_chest)
            mk(f'foot_{s}', footfwd, side_hips)
        return F

    PS0, PT0 = positions(src, smap, False), positions(tgt, tmap, False)
    FT0, FS0 = frames(PT0), frames(PS0)
    RT0 = {j: wrot(tgt, tgt.data.bones[tmap[j]].matrix_local) for j in joints}
    leglen = lambda P: (P['shin_l'] - P['thigh_l']).length + (P['foot_l'] - P['shin_l']).length
    ratio = leglen(PT0) / leglen(PS0)
    s_floor = min(PS0['toe_l'].z, PS0['foot_l'].z)
    # target hips height when standing straight (its rest stance is a crouch): leg length above the floor
    t_floor = 0.0

    order = []
    def walk(b):
        order.append(b)
        for c in b.children: walk(c)
    for b in tgt.data.bones:
        if not b.parent: walk(b)
    rest_rel = {b.name: (b.parent.matrix_local.inverted() @ b.matrix_local) if b.parent else b.matrix_local.copy() for b in order}
    inv_tw = tgt.matrix_world.inverted()
    tq_inv = tgt.matrix_world.to_quaternion().inverted()
    by_bone = {tmap[j]: j for j in joints}

    out = bpy.data.actions.new(clip)
    f0, f1 = int(round(act.frame_range[0])), int(round(act.frame_range[1]))
    # loops are played in place: remove any forward travel baked into the source (Mixamo clips without "In Place")
    drift = Vector()
    if clip in LOOPS:
        scn.frame_set(f0); h0 = src.matrix_world @ src.pose.bones[smap['hips']].head
        scn.frame_set(f1); h1 = src.matrix_world @ src.pose.bones[smap['hips']].head
        drift = Vector((h1.x - h0.x, h1.y - h0.y, 0))
    assign(tgt, out)
    for f in range(f0, f1 + 1):
        scn.frame_set(f)
        PS = positions(src, smap, True)
        PS['hips'] = PS['hips'] - drift * ((f - f0) / max(1, f1 - f0))
        FS = frames(PS)
        pose = {}
        for b in order:
            parent_pose = pose[b.parent.name] if b.parent else Matrix.Identity(4)
            base = parent_pose @ rest_rel[b.name]
            j = by_bone.get(b.name)
            if j is None:
                pose[b.name] = base
                continue
            if j in FS:
                qw = FS[j] @ (FS0[j] if j in REL else FT0[j]).inverted() @ RT0[j]
            elif j in fingers and CHILD.get(j) in PS:
                qw = (PT0[CHILD[j]] - PT0[j]).rotation_difference(PS[CHILD[j]] - PS[j]) @ RT0[j]
            else:
                pose[b.name] = base
                continue
            qa = tq_inv @ qw
            loc = base.translation
            if j == 'hips':
                p = PS['hips']
                loc = inv_tw @ Vector((p.x * ratio, p.y * ratio, t_floor + (p.z - s_floor) * ratio))
            m = Matrix.LocRotScale(loc, qa, base.to_scale())
            pose[b.name] = m
            tpb = tgt.pose.bones[b.name]
            tpb.matrix_basis = base.inverted() @ m
            tpb.keyframe_insert('rotation_quaternion', frame=f - f0, group=b.name)
            if j == 'hips': tpb.keyframe_insert('location', frame=f - f0, group=b.name)
    tgt.animation_data.action = None
    tr = tgt.animation_data.nla_tracks.new(); tr.name = clip
    tr.strips.new(clip, 0, out)
    tr.mute = True
    for pb in tgt.pose.bones: pb.matrix_basis = Matrix.Identity(4)
    return f1 - f0 + 1


# ---------------------------------------------------------------- analysis / preview / export
def analyse(tgt, meta_in):
    """Per clip: duration + detected blade swings, arc planes in glTF space (character faces +Z, Y up)."""
    to_gl = lambda v: [round(v.x, 4), round(v.z, 4), round(-v.y, 4)]
    scn = bpy.context.scene
    tmap = resolve(tgt)
    grip, chest, hipsb = tgt.pose.bones['katana_grip'], tgt.pose.bones[tmap['chest']], tgt.pose.bones[tmap['hips']]
    mw = tgt.matrix_world
    H = meta_in['height']
    blade = meta_in['blade']
    thr = 8.0 * H / 1.72               # Noir's 8 m/s tip threshold, scaled to the mech
    clips = {}
    for tr in tgt.animation_data.nla_tracks:
        act = tr.strips[0].action
        assign(tgt, act)
        n = int(act.frame_range[1])
        tips, centers, hips = [], [], []
        for f in range(0, n + 1):
            scn.frame_set(f)
            gm = mw @ grip.matrix
            axis = (gm.to_3x3() @ Vector((0, 1, 0))).normalized()
            tips.append(gm.translation + axis * blade)
            centers.append(mw @ chest.head)
            hips.append(mw @ hipsb.head)
        speed = [0.0] + [(tips[i] - tips[i - 1]).length * FPS for i in range(1, len(tips))]
        swings, i = [], 0
        while i < len(speed):
            if speed[i] > thr:
                j = i
                while j + 1 < len(speed) and (speed[j + 1] > thr or (j + 2 < len(speed) and speed[j + 2] > thr)): j += 1
                if j - i >= 1: swings.append((i - 1, j))
                i = j + 1
            else: i += 1
        out = []
        for a, b in swings:
            a = max(a, 0)
            c = sum((centers[k] for k in range(a, b + 1)), Vector()) / (b - a + 1)
            nrm = Vector()
            for k in range(a, b): nrm += (tips[k] - c).cross(tips[k + 1] - c)
            if nrm.length < 1e-6: continue
            nrm.normalize()
            u = tips[a] - c; u = (u - nrm * u.dot(nrm)).normalized()
            v = nrm.cross(u)
            ang = 0.0
            for k in range(a, b):
                p0 = tips[k] - c; p1 = tips[k + 1] - c
                p0 = p0 - nrm * p0.dot(nrm); p1 = p1 - nrm * p1.dot(nrm)
                ang += math.atan2(p0.cross(p1).dot(nrm), p0.dot(p1))
            r = sum(((tips[k] - c) - nrm * (tips[k] - c).dot(nrm)).length for k in range(a, b + 1)) / (b - a + 1)
            reach = max(Vector((tips[k].x - hips[k].x, tips[k].y - hips[k].y)).length for k in range(a, b + 1))
            hang = [math.atan2(tips[k].x - hips[k].x, -(tips[k].y - hips[k].y)) for k in range(a, b + 1)]
            out.append({'t0': round(a / FPS, 3), 't1': round(b / FPS, 3), 'peak': round(max(speed[a:b + 1]) / H * 1.72, 1),
                        'c': to_gl(c), 'u': to_gl(u), 'v': to_gl(v), 'a1': round(ang, 3), 'r': round(r, 3),
                        'reach': round(reach, 2), 'h0': round(min(hang), 2), 'h1': round(max(hang), 2)})
        clips[tr.name] = {'dur': round(n / FPS, 3), 'swings': out}
    tgt.animation_data.action = None
    meta = dict(meta_in, clips=clips, loops=LOOPS)
    path = os.path.splitext(OUT)[0] + '.json'
    os.makedirs(os.path.dirname(path), exist_ok=True)
    json.dump(meta, open(path, 'w'), indent=1)
    print('[meta]', path, sum(len(m['swings']) for m in clips.values()), 'swings')


def preview(tgt, clips):
    os.makedirs(PREVIEW, exist_ok=True)
    scn = bpy.context.scene
    scn.render.engine = 'BLENDER_WORKBENCH'
    scn.display.shading.color_type = 'MATERIAL'
    scn.display.shading.show_cavity = True
    scn.render.resolution_x, scn.render.resolution_y = 420, 500
    cam = bpy.data.objects.new('cam', bpy.data.cameras.new('cam')); scn.collection.objects.link(cam)
    cam.data.lens = 40
    scn.camera = cam
    sun = bpy.data.objects.new('sun', bpy.data.lights.new('sun', 'SUN')); scn.collection.objects.link(sun)
    hips = tgt.pose.bones[resolve(tgt)['hips']]
    tracks = [tr for tr in tgt.animation_data.nla_tracks if not clips or tr.name in clips]
    for tr in tracks or [None]:
        act = tr.strips[0].action if tr else None
        if act: assign(tgt, act)
        n = int(act.frame_range[1]) if act else 0
        for i, f in enumerate([round(n * k / 5) for k in range(6)] if act else [0]):
            scn.frame_set(f)
            h = tgt.matrix_world @ hips.head
            cam.location = Vector((h.x, h.y, 0)) + Vector((6.5, -11.0, 3.4))
            cam.rotation_euler = (math.radians(82), 0, math.radians(31))
            scn.render.filepath = os.path.join(PREVIEW, f'{tr.name if tr else "rest"}_{i}.png')
            bpy.ops.render.render(write_still=True)
    tgt.animation_data.action = None if tgt.animation_data else None
    bpy.data.objects.remove(cam, do_unlink=True)
    bpy.data.objects.remove(sun, do_unlink=True)


def export(tgt):
    bpy.ops.object.select_all(action='DESELECT')
    tgt.select_set(True)
    for o in bpy.data.objects:
        if o.type == 'MESH': o.select_set(True)
    for tr in tgt.animation_data.nla_tracks: tr.mute = False
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=OUT, export_format='GLB', use_selection=True,
        export_animations=True, export_animation_mode='NLA_TRACKS', export_force_sampling=True,
        export_optimize_animation_size=True, export_skins=True, export_def_bones=False,
        export_yup=True, export_apply=False, export_image_format='WEBP', export_image_quality=85,
        export_draco_mesh_compression_enable=True, export_draco_mesh_compression_level=6)


def main():
    tgt, meta = prep_target()
    if not tgt.animation_data: tgt.animation_data_create()
    n = 0
    for clip, path in CLIPS.items():
        if ONLY and clip not in ONLY: continue
        if LOD and clip not in ENEMY_CLIPS: continue
        try:
            print(f'[clip] {clip}: {retarget(tgt, clip, path)} frames', flush=True); n += 1
        except Exception as e:
            print(f'[clip] {clip}: FAILED {e}', flush=True)
    if PREVIEW: preview(tgt, ONLY)
    analyse(tgt, meta)
    export(tgt)
    print(f'{os.path.basename(OUT)} built: {OUT} ({os.path.getsize(OUT) / 1e6:.1f} MB, {n} clips)')


main()
