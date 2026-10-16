"""
Sci-Fi Airlock Interior -- procedural scene generator
=====================================================

Blender 4.x / 5.x, Cycles.  Paste into the Text Editor and press Alt+P, or run
headless with:  blender --python scifi_airlock.py

Layout: metres, Z up.  The corridor runs along +Y from the camera (Y = -3.5)
to the octagonal blast door (Y = +2.0).  X = 0 is the centre line, the side
walls sit at |X| = 1.5 and the walkable grating is at Z = 0.5 above a
cable / pipe trench whose floor is Z = 0.  Behind the door is the octagonal
microgravity module: an equipment lock (Y = 2.5 .. 5.0), a bulkhead with a
sliding pressure hatch (Y = 5.0 .. 5.3) and the crew lock with decon rings
(Y = 5.3 .. 9.5), closed by an outer hatch with a porthole.
Set DOOR_OPEN_FRACTION / HATCH_OPEN_FRACTION to slide the leaves open for a render.

`export_glb.py` runs this script and exports the scene for the three.js
viewer in `web/`.

All geometry is built with bmesh / bpy.data instead of bpy.ops, so the script
does not depend on the active editor, the selection or the current mode.
Re-running it rebuilds the scene from scratch.
"""

import math

import bmesh
import bpy
from mathutils import Vector

# =============================================================================
# Layout (metres)
# =============================================================================
HALF_W = 1.5                  # inner face of the side walls (|x|)
TRENCH_Z = 0.0                # trench floor
GRATE_TOP_Z = 0.5             # walkable grating, 0.5 m above the trench
GRATE_THICKNESS = 0.03
GRATE_HALF_W = 1.195          # grating stops just short of the side curbs
CEIL_Z = 3.55
CEIL_CHAMFER = 0.55           # 45 degree chamfer between wall and ceiling
FLOOR_CHAMFER = 0.05

Y_START = -4.0                # back bulkhead, behind the camera
Y_DOOR = 2.0                  # front face of the door bulkhead wall
Y_DETAIL_END = 1.9            # grating / wall panels stop before the door trim
SHELL_Y_END = 2.7

RIB_COUNT = 4
RIB_FIRST_Y = -2.8
RIB_SPACING = 1.4
RIB_DEPTH = 0.36
RIB_LIP = 0.035               # flange standing proud of both rib faces

DOOR_CENTER_Z = 1.75
DOOR_APOTHEM = 1.25           # bottom edge of the door is flush with the grating
OPENING_APOTHEM = 1.31
TRIM_OUTER_APOTHEM = 1.41
TRIM_INNER_APOTHEM = 1.30
DOOR_Y_FRONT = 2.12           # door face is recessed 12 cm behind the bulkhead
DOOR_Y_BACK = 2.40
DOOR_WALL_DEPTH = 0.5
DOOR_SEAM = 0.012             # half-width of the vertical split between leaves
DOOR_SLIDE = 1.32             # how far each leaf travels into the bulkhead pocket
DOOR_OPEN_FRACTION = 0.0      # 0 = closed, 1 = fully open (leaves slide sideways)

# Octagonal module behind the blast door: equipment lock, hatch bulkhead, crew lock.
CHAMBER_Y0 = Y_DOOR + DOOR_WALL_DEPTH - 0.01   # start of the equipment lock
CHAMBER_Y1 = 9.5              # inner face of the outer hatch wall
CHAMBER_APOTHEM = 1.45        # inner surface
CHAMBER_OUTER_APOTHEM = 1.62
CHAMBER_FLOOR_HALF_W = 0.82
EQUIP_SEAM_Y = 3.75           # trim frame halfway along the equipment lock
HATCH_WALL_Y0 = 5.0           # equipment-lock face of the hatch bulkhead
HATCH_WALL_Y1 = 5.3           # crew-lock face
HATCH_LEAF_Y0 = 5.11
HATCH_LEAF_Y1 = 5.19
HATCH_HALF_W = 0.55           # opening: |x| <= 0.55, from the floor up to HATCH_TOP_Z
HATCH_TOP_Z = 2.75
HATCH_TOP_CHAMFER = 0.3
HATCH_LEAF_OVERLAP = 0.04     # leaves reach this far into the jambs when closed
HATCH_SLIDE = 0.64            # leaves slide fully into the bulkhead
HATCH_OPEN_FRACTION = 0.0
CREW_Y0 = HATCH_WALL_Y1       # crew lock: decon rings and the outer hatch
CHAMBER_RING_YS = (6.7, 8.1)

PANEL_FRONT_X = HALF_W - 0.06  # wall panels stand 6 cm proud of the wall
CONDUIT_X = HALF_W - 0.085     # conduit centre line, clear of the panel faces

CAMERA_LOCATION = (0.0, -3.5, 1.6)
CAMERA_LENS_MM = 32.0
CAMERA_FSTOP = 2.8

RENDER_RESOLUTION = (1920, 1080)
RENDER_SAMPLES = 256

COLLECTION_NAME = "SciFi_Airlock"
CLEAR_TYPES = {"MESH", "CURVE", "CAMERA", "LIGHT"}
GPU_BACKENDS = ("OPTIX", "CUDA", "HIP", "ONEAPI", "METAL")
AGX_HIGH_CONTRAST_LOOKS = ("AgX - High Contrast", "High Contrast")

TAN_22_5 = math.tan(math.radians(22.5))


def log(message):
    print(f"[SciFi Airlock] {message}")


# =============================================================================
# Colour helpers
# =============================================================================
def srgb_to_linear(channel):
    if channel <= 0.04045:
        return channel / 12.92
    return ((channel + 0.055) / 1.055) ** 2.4


def hex_to_rgba(hex_code, alpha=1.0):
    """'#RRGGBB' (sRGB, as typed in a colour picker) -> linear RGBA for nodes."""
    value = hex_code.lstrip("#")
    r, g, b = (int(value[i:i + 2], 16) / 255.0 for i in (0, 2, 4))
    return (srgb_to_linear(r), srgb_to_linear(g), srgb_to_linear(b), alpha)


def kelvin_to_rgb(kelvin):
    """Approximate black-body colour (Tanner Helland fit) as linear RGB."""
    t = kelvin / 100.0
    if t <= 66.0:
        r = 255.0
        g = 99.4708025861 * math.log(t) - 161.1195681661
    else:
        r = 329.698727446 * (t - 60.0) ** -0.1332047592
        g = 288.1221695283 * (t - 60.0) ** -0.0755148492
    if t >= 66.0:
        b = 255.0
    elif t <= 19.0:
        b = 0.0
    else:
        b = 138.5177312231 * math.log(t - 10.0) - 305.0447927307
    return tuple(srgb_to_linear(min(max(c, 0.0), 255.0) / 255.0) for c in (r, g, b))


# =============================================================================
# Scene reset and render settings
# =============================================================================
def ensure_object_mode():
    view_layer = bpy.context.view_layer
    active = view_layer.objects.active if view_layer else None
    if active is not None and active.mode != "OBJECT":
        try:
            bpy.ops.object.mode_set(mode="OBJECT")
        except RuntimeError as exc:
            log(f"could not leave {active.mode} mode: {exc}")


def clear_scene(scene):
    doomed = [obj for obj in scene.objects if obj.type in CLEAR_TYPES]
    for obj in doomed:
        bpy.data.objects.remove(obj, do_unlink=True)
    for datablocks in (bpy.data.meshes, bpy.data.curves, bpy.data.cameras, bpy.data.lights):
        for block in list(datablocks):
            if block.users == 0:
                datablocks.remove(block)
    log(f"removed {len(doomed)} mesh/curve/camera/light objects")


def get_build_collection(scene):
    collection = bpy.data.collections.get(COLLECTION_NAME)
    if collection is None:
        collection = bpy.data.collections.new(COLLECTION_NAME)
    if scene.collection.children.get(collection.name) is None:
        scene.collection.children.link(collection)
    collection.hide_render = False
    collection.hide_viewport = False
    # Curves are converted through the depsgraph, so the collection must be
    # evaluated (not excluded) in the active view layer.
    layer_collection = bpy.context.view_layer.layer_collection.children.get(collection.name)
    if layer_collection is not None:
        layer_collection.exclude = False
    return collection


def enable_gpu(scene):
    """Pick the first GPU backend with a usable device; otherwise use the CPU."""
    addon = bpy.context.preferences.addons.get("cycles")
    if addon is None:
        scene.cycles.device = "CPU"
        return "CPU (Cycles preferences unavailable)"
    prefs = addon.preferences
    for backend in GPU_BACKENDS:
        try:
            prefs.compute_device_type = backend
        except (TypeError, ValueError):
            continue  # backend not compiled into this build / platform
        try:
            if hasattr(prefs, "refresh_devices"):
                prefs.refresh_devices()
            else:
                prefs.get_devices()
        except (RuntimeError, AttributeError) as exc:
            log(f"device query for {backend} failed: {exc}")
            continue
        gpus = [device for device in prefs.devices if device.type == backend]
        if not gpus:
            continue
        for device in prefs.devices:
            device.use = device.type == backend
        scene.cycles.device = "GPU"
        return f"GPU / {backend} ({', '.join(device.name for device in gpus)})"
    try:
        prefs.compute_device_type = "NONE"
    except (TypeError, ValueError):
        pass
    scene.cycles.device = "CPU"
    return "CPU (no supported GPU found)"


def configure_render(scene):
    try:
        scene.render.engine = "CYCLES"
    except TypeError:
        bpy.ops.preferences.addon_enable(module="cycles")
        scene.render.engine = "CYCLES"
    device = enable_gpu(scene)

    cycles = scene.cycles
    cycles.samples = RENDER_SAMPLES
    cycles.use_denoising = True
    cycles.max_bounces = 12
    cycles.diffuse_bounces = 4
    cycles.glossy_bounces = 6
    cycles.sample_clamp_indirect = 10.0

    scene.render.resolution_x, scene.render.resolution_y = RENDER_RESOLUTION
    scene.render.resolution_percentage = 100
    scene.render.film_transparent = False
    scene.unit_settings.system = "METRIC"
    scene.unit_settings.scale_length = 1.0
    return device


def configure_color_management(scene):
    try:
        scene.display_settings.display_device = "sRGB"
    except TypeError as exc:
        log(f"display device left unchanged: {exc}")

    view = scene.view_settings
    try:
        view.view_transform = "AgX"
    except TypeError as exc:
        log(f"AgX view transform unavailable: {exc}")

    applied_look = None
    for look in AGX_HIGH_CONTRAST_LOOKS:
        try:
            view.look = look
        except TypeError:
            continue
        applied_look = look
        break
    if applied_look is None:
        log("no AgX 'High Contrast' look found; look left unchanged")

    view.exposure = -0.5
    view.gamma = 1.0
    return applied_look


# =============================================================================
# Node helpers
# =============================================================================
def node_tree_of(id_block):
    """Node tree of a material or world.  5.x always has nodes; 4.x needs use_nodes."""
    if bpy.app.version < (5, 0, 0) or id_block.node_tree is None:
        id_block.use_nodes = True
    return id_block.node_tree


def find_socket(sockets, *keys):
    """First socket matching one of `keys` (names or indices), else None."""
    for key in keys:
        if isinstance(key, int):
            if 0 <= key < len(sockets):
                return sockets[key]
        else:
            socket = sockets.get(key)
            if socket is not None:
                return socket
    return None


def set_inputs(node, values):
    for keys, value in values:
        keys = (keys,) if isinstance(keys, (str, int)) else keys
        socket = find_socket(node.inputs, *keys)
        if socket is None or not hasattr(socket, "default_value"):
            log(f"{node.bl_idname} has no input {keys}; skipped")
            continue
        socket.default_value = value


def connect(node_tree, src, src_keys, dst, dst_keys):
    src_keys = (src_keys,) if isinstance(src_keys, (str, int)) else src_keys
    dst_keys = (dst_keys,) if isinstance(dst_keys, (str, int)) else dst_keys
    out_socket = find_socket(src.outputs, *src_keys)
    in_socket = find_socket(dst.inputs, *dst_keys)
    if out_socket is None or in_socket is None:
        log(f"could not link {src.bl_idname}{src_keys} -> {dst.bl_idname}{dst_keys}")
        return None
    return node_tree.links.new(out_socket, in_socket)


# =============================================================================
# Materials
# =============================================================================
def build_principled(name, base_color, metallic, roughness, emission=None,
                     emission_strength=0.0, coat=0.0, coat_roughness=0.05):
    material = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    node_tree = node_tree_of(material)
    node_tree.nodes.clear()

    output = node_tree.nodes.new("ShaderNodeOutputMaterial")
    output.location = (350, 0)
    bsdf = node_tree.nodes.new("ShaderNodeBsdfPrincipled")
    bsdf.location = (0, 0)
    connect(node_tree, bsdf, "BSDF", output, "Surface")

    values = [("Base Color", base_color), ("Metallic", metallic), ("Roughness", roughness)]
    if coat > 0.0:
        values += [
            (("Coat Weight", "Coat"), coat),
            ("Coat Roughness", coat_roughness),
        ]
    if emission is not None:
        values += [
            (("Emission Color", "Emission"), emission),
            ("Emission Strength", emission_strength),
        ]
    set_inputs(bsdf, values)

    # Solid-mode viewport colours.
    material.diffuse_color = emission if emission is not None else base_color
    material.metallic = metallic
    material.roughness = roughness
    return material, node_tree, bsdf


def add_steel_bump(node_tree, bsdf, strength=0.035):
    """Noise + Voronoi height field -> Bump -> BSDF normal (fine milling dents)."""
    nodes = node_tree.nodes
    coords = nodes.new("ShaderNodeTexCoord")
    coords.location = (-1100, 0)

    noise = nodes.new("ShaderNodeTexNoise")
    noise.location = (-850, 180)
    set_inputs(noise, [("Scale", 38.0), ("Detail", 6.0), ("Roughness", 0.55)])

    voronoi = nodes.new("ShaderNodeTexVoronoi")
    voronoi.location = (-850, -180)
    set_inputs(voronoi, [("Scale", 12.0), ("Randomness", 0.85)])

    connect(node_tree, coords, "Object", noise, "Vector")
    connect(node_tree, coords, "Object", voronoi, "Vector")

    voronoi_weight = nodes.new("ShaderNodeMath")
    voronoi_weight.operation = "MULTIPLY"
    voronoi_weight.location = (-600, -180)
    set_inputs(voronoi_weight, [(1, 0.2)])
    connect(node_tree, voronoi, "Distance", voronoi_weight, 0)

    height = nodes.new("ShaderNodeMath")
    height.operation = "ADD"
    height.location = (-420, 0)
    connect(node_tree, noise, "Fac", height, 0)
    connect(node_tree, voronoi_weight, "Value", height, 1)

    bump = nodes.new("ShaderNodeBump")
    bump.location = (-220, -150)
    set_inputs(bump, [("Strength", strength), ("Distance", 0.02)])
    connect(node_tree, height, "Value", bump, "Height")
    connect(node_tree, bump, "Normal", bsdf, "Normal")


def build_materials():
    steel, steel_tree, steel_bsdf = build_principled(
        "Airlock_CoatedDarkSteel", hex_to_rgba("#1A1C20"), 0.85, 0.38,
        coat=0.25, coat_roughness=0.08,
    )
    add_steel_bump(steel_tree, steel_bsdf)

    chrome = build_principled("Airlock_GrateChrome", (0.62, 0.63, 0.65, 1.0), 1.0, 0.18)[0]
    warning = build_principled(
        "Airlock_WarningEmission", (0.02, 0.02, 0.02, 1.0), 0.0, 0.35,
        emission=hex_to_rgba("#FF2200"), emission_strength=25.0,
    )[0]
    accent = build_principled(
        "Airlock_SubfloorAccent", (0.02, 0.02, 0.02, 1.0), 0.0, 0.35,
        emission=hex_to_rgba("#00E5FF"), emission_strength=15.0,
    )[0]
    trench = build_principled("Airlock_TrenchGunmetal", hex_to_rgba("#0B0C0E"), 0.7, 0.55)[0]
    rubber = build_principled("Airlock_SealRubber", hex_to_rgba("#050505"), 0.0, 0.8)[0]
    # The ceiling needs real diffuse albedo, otherwise the grating shadows
    # projected by the trench up-lights cannot show up on it.
    ceiling = build_principled("Airlock_CeilingPaint", hex_to_rgba("#6B7078"), 0.1, 0.55)[0]
    # Same look as the warning emission, but its own material so a viewer can
    # recolour the door indicators (e.g. red -> green while the door opens).
    indicator = build_principled(
        "Airlock_DoorIndicator", (0.02, 0.02, 0.02, 1.0), 0.0, 0.35,
        emission=hex_to_rgba("#FF2200"), emission_strength=25.0,
    )[0]

    chamber_white = build_principled(
        "Airlock_ChamberWhite", hex_to_rgba("#C9CDD2"), 0.0, 0.35, coat=0.3, coat_roughness=0.05,
    )[0]
    chamber_light = build_principled(
        "Airlock_ChamberLight", (0.02, 0.02, 0.02, 1.0), 0.0, 0.35,
        emission=hex_to_rgba("#DFF7FF"), emission_strength=10.0,
    )[0]
    equip_light = build_principled(
        "Airlock_EquipLight", (0.02, 0.02, 0.02, 1.0), 0.0, 0.35,
        emission=hex_to_rgba("#FFF1DE"), emission_strength=8.0,
    )[0]
    # Separate from the blast-door indicator so the viewer can recolour each door.
    hatch_indicator = build_principled(
        "Airlock_HatchIndicator", (0.02, 0.02, 0.02, 1.0), 0.0, 0.35,
        emission=hex_to_rgba("#FF2200"), emission_strength=25.0,
    )[0]
    cargo = build_principled("Airlock_CargoBag", hex_to_rgba("#CFC7B0"), 0.0, 0.85)[0]
    strap = build_principled("Airlock_CargoStrap", hex_to_rgba("#26344F"), 0.0, 0.7)[0]
    hazard = build_principled("Airlock_HazardYellow", hex_to_rgba("#F2B705"), 0.0, 0.5)[0]
    glass, _, glass_bsdf = build_principled("Airlock_PortholeGlass", (0.6, 0.8, 0.9, 1.0), 0.0, 0.05)
    set_inputs(glass_bsdf, [("Alpha", 0.12)])
    if hasattr(glass, "surface_render_method"):
        glass.surface_render_method = "BLENDED"
    elif hasattr(glass, "blend_method"):
        glass.blend_method = "BLEND"
    planet = build_principled(
        "Airlock_Planet", (0.02, 0.05, 0.1, 1.0), 0.0, 0.6,
        emission=hex_to_rgba("#2E6FB8"), emission_strength=1.5,
    )[0]
    stars = build_principled(
        "Airlock_Stars", (0.0, 0.0, 0.0, 1.0), 0.0, 1.0,
        emission=(1.0, 1.0, 1.0, 1.0), emission_strength=6.0,
    )[0]
    return {
        "steel": steel, "chrome": chrome, "warning": warning,
        "accent": accent, "trench": trench, "rubber": rubber, "ceiling": ceiling,
        "indicator": indicator, "chamber_white": chamber_white, "chamber_light": chamber_light,
        "equip_light": equip_light, "hatch_indicator": hatch_indicator, "cargo": cargo, "strap": strap,
        "hazard": hazard, "glass": glass, "planet": planet, "stars": stars,
    }


def configure_world(scene):
    world = scene.world or bpy.data.worlds.new("Airlock_World")
    scene.world = world
    node_tree = node_tree_of(world)
    node_tree.nodes.clear()
    background = node_tree.nodes.new("ShaderNodeBackground")
    output = node_tree.nodes.new("ShaderNodeOutputWorld")
    output.location = (250, 0)
    dark_cyan = (0.0, 0.006, 0.008, 1.0)
    set_inputs(background, [("Color", dark_cyan), ("Strength", 0.01)])
    connect(node_tree, background, "Background", output, "Surface")
    world.color = dark_cyan[:3]


# =============================================================================
# Cross-section profiles (XZ plane, counter-clockwise).  Every profile has 8
# vertices in the same order, so any two can be bridged quad-for-quad into a
# frame (rib, bulkhead, trim ring).
# =============================================================================
def chamfered_rect(x0, x1, z0, z1, chamfer_bottom, chamfer_top):
    cb, ct = chamfer_bottom, chamfer_top
    return [
        (x0 + cb, z0), (x1 - cb, z0),
        (x1, z0 + cb), (x1, z1 - ct),
        (x1 - ct, z1), (x0 + ct, z1),
        (x0, z1 - ct), (x0, z0 + cb),
    ]


def shell_profile(offset=0.0):
    """Corridor cross-section grown outward by `offset` (exact parallel offset)."""
    grow = offset * (2.0 - math.sqrt(2.0))
    return chamfered_rect(
        -HALF_W - offset, HALF_W + offset, TRENCH_Z - offset, CEIL_Z + offset,
        FLOOR_CHAMFER + grow, CEIL_CHAMFER + grow,
    )


def octagon(apothem, center_z, center_x=0.0):
    """Regular octagon with flat top/bottom/sides."""
    t = apothem * TAN_22_5
    a, cx, cz = apothem, center_x, center_z
    return [
        (cx - t, cz - a), (cx + t, cz - a),
        (cx + a, cz - t), (cx + a, cz + t),
        (cx + t, cz + a), (cx - t, cz + a),
        (cx - a, cz + t), (cx - a, cz - t),
    ]


def hexagon(center_x, center_z, radius):
    return [
        (center_x + radius * math.cos(math.radians(60 * k + 30)),
         center_z + radius * math.sin(math.radians(60 * k + 30)))
        for k in range(6)
    ]


def circle(radius, center_z, count, center_x=0.0):
    """Circle starting at the same angle (-112.5 deg) as octagon()'s first vertex."""
    return [
        (center_x + radius * math.cos(math.radians(-112.5 + 360.0 * k / count)),
         center_z + radius * math.sin(math.radians(-112.5 + 360.0 * k / count)))
        for k in range(count)
    ]


def resample_closed(loop, per_edge):
    """Subdivide every edge of a closed loop so it can be bridged to a circle."""
    result = []
    for (x0, z0), (x1, z1) in zip(loop, loop[1:] + loop[:1]):
        for k in range(per_edge):
            t = k / per_edge
            result.append((x0 + (x1 - x0) * t, z0 + (z1 - z0) * t))
    return result


def half_octagon(apothem, center_z, side, gap=DOOR_SEAM):
    """One side (side = +1 right, -1 left) of a flat-topped octagon, split at x = +-gap."""
    t = apothem * TAN_22_5
    a, c = apothem, center_z
    right = [(gap, c - a), (t, c - a), (a, c - t), (a, c + t), (t, c + a), (gap, c + a)]
    return right if side > 0 else [(-x, z) for x, z in reversed(right)]


def half_octagon_ring(outer_apothem, inner_apothem, center_z, side, gap=DOOR_SEAM):
    """C-shaped half of an octagonal ring, split at x = +-gap."""
    outer = half_octagon(outer_apothem, center_z, 1.0, gap)
    inner = half_octagon(inner_apothem, center_z, 1.0, gap)
    loop = outer + list(reversed(inner))
    return loop if side > 0 else [(-x, z) for x, z in reversed(loop)]


def clip_polygon(poly, a, b, limit):
    """Sutherland-Hodgman: keep the part of `poly` where a*x + b*y <= limit."""
    result = []
    for p, q in zip(poly, poly[1:] + poly[:1]):
        fp = a * p[0] + b * p[1] - limit
        fq = a * q[0] + b * q[1] - limit
        if fp <= 0.0:
            result.append(p)
        if (fp <= 0.0) != (fq <= 0.0):
            t = fp / (fp - fq)
            result.append((p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t))
    return result


# =============================================================================
# bmesh primitives
# =============================================================================
def bm_prism(bm, loop, y0, y1):
    """Closed prism: XZ polygon `loop` extruded from y0 to y1."""
    front = [bm.verts.new((x, y0, z)) for x, z in loop]
    back = [bm.verts.new((x, y1, z)) for x, z in loop]
    caps = [bm.faces.new(front), bm.faces.new(list(reversed(back)))]
    sides = []
    count = len(loop)
    for i in range(count):
        j = (i + 1) % count
        sides.append(bm.faces.new((front[i], back[i], back[j], front[j])))
    bmesh.ops.recalc_face_normals(bm, faces=caps + sides)
    return {"front": caps[0], "back": caps[1], "sides": sides}


def bm_box(bm, x0, x1, y0, y1, z0, z1):
    """Axis-aligned box; returns its faces keyed by outward direction."""
    x0, x1 = sorted((x0, x1))
    y0, y1 = sorted((y0, y1))
    z0, z1 = sorted((z0, z1))
    parts = bm_prism(bm, [(x0, z0), (x1, z0), (x1, z1), (x0, z1)], y0, y1)
    bottom, pos_x, top, neg_x = parts["sides"]
    return {"-Y": parts["front"], "+Y": parts["back"], "-Z": bottom,
            "+X": pos_x, "+Z": top, "-X": neg_x}


def bm_ring(bm, outer, inner, y0, y1):
    """Frame between two matching XZ loops, extruded from y0 to y1."""
    count = len(outer)
    if len(inner) != count:
        raise ValueError("outer and inner loops need the same vertex count")
    outer_front = [bm.verts.new((x, y0, z)) for x, z in outer]
    outer_back = [bm.verts.new((x, y1, z)) for x, z in outer]
    inner_front = [bm.verts.new((x, y0, z)) for x, z in inner]
    inner_back = [bm.verts.new((x, y1, z)) for x, z in inner]
    parts = {"front": [], "back": [], "outer": [], "inner": []}
    for i in range(count):
        j = (i + 1) % count
        parts["front"].append(bm.faces.new((outer_front[i], outer_front[j], inner_front[j], inner_front[i])))
        parts["back"].append(bm.faces.new((outer_back[j], outer_back[i], inner_back[i], inner_back[j])))
        parts["outer"].append(bm.faces.new((outer_front[j], outer_front[i], outer_back[i], outer_back[j])))
        parts["inner"].append(bm.faces.new((inner_front[i], inner_front[j], inner_back[j], inner_back[i])))
    bmesh.ops.recalc_face_normals(bm, faces=[f for faces in parts.values() for f in faces])
    return parts  # each list is ordered like the loop edges (edge i = point i -> i+1)


def bm_prism_z(bm, loop_xy, z0, z1):
    """Closed prism: XY polygon extruded from z0 to z1 (floor markings)."""
    bottom = [bm.verts.new((x, y, z0)) for x, y in loop_xy]
    top = [bm.verts.new((x, y, z1)) for x, y in loop_xy]
    faces = [bm.faces.new(bottom), bm.faces.new(list(reversed(top)))]
    for i in range(len(loop_xy)):
        j = (i + 1) % len(loop_xy)
        faces.append(bm.faces.new((bottom[i], bottom[j], top[j], top[i])))
    bmesh.ops.recalc_face_normals(bm, faces=faces)


class MaterialSlot:
    """`with MaterialSlot(bm, 2): ...` puts every face created inside the block
    on material slot 2 (for multi-material objects)."""

    def __init__(self, bm, index):
        self.bm, self.index = bm, index

    def __enter__(self):
        self.before = set(self.bm.faces)
        return self

    def __exit__(self, *_):
        for face in self.bm.faces:
            if face not in self.before:
                face.material_index = self.index
        return False


def bm_bar_xz(bm, p0, p1, width, y0, y1):
    """Rectangular bar of `width` running from p0 to p1 in the XZ plane."""
    a, b = Vector(p0), Vector(p1)
    direction = (b - a).normalized()
    side = Vector((-direction.y, direction.x)) * (width / 2.0)
    loop = [tuple(a - side), tuple(b - side), tuple(b + side), tuple(a + side)]
    return bm_prism(bm, loop, y0, y1)


def inset_extrude(bm, face, inset, depth):
    """Inset `face`, then move the inner face along its normal by `depth`
    (negative = recess) with straight side walls.  Returns the new cap face."""
    bmesh.ops.inset_individual(bm, faces=[face], thickness=inset, depth=0.0, use_even_offset=True)
    face.normal_update()
    normal = face.normal.copy()
    result = bmesh.ops.extrude_face_region(bm, geom=[face])
    new_verts = [elem for elem in result["geom"] if isinstance(elem, bmesh.types.BMVert)]
    new_faces = [elem for elem in result["geom"] if isinstance(elem, bmesh.types.BMFace)]
    bmesh.ops.translate(bm, vec=normal * depth, verts=new_verts)
    if face.is_valid:
        bmesh.ops.delete(bm, geom=[face], context="FACES_ONLY")
    moved = set(new_verts)
    cap = next(f for f in new_faces if all(v in moved for v in f.verts))
    cap.normal_update()
    return cap


def apply_hard_surface_shading(mesh, angle_deg=30.0):
    """Smooth shading with sharp edges above `angle_deg` (4.1+ API, 4.0 fallback)."""
    mesh.polygons.foreach_set("use_smooth", [True] * len(mesh.polygons))
    angle = math.radians(angle_deg)
    if hasattr(mesh, "set_sharp_from_angle"):
        mesh.set_sharp_from_angle(angle=angle)
    elif hasattr(mesh, "use_auto_smooth"):
        mesh.use_auto_smooth = True
        mesh.auto_smooth_angle = angle
    mesh.update()


def add_box_uvs(bm):
    """World-space box projection, 1 UV unit = 1 m, so tiling detail maps
    (e.g. in a glTF / three.js viewer) line up across separate objects."""
    bm.normal_update()
    uv_layer = bm.loops.layers.uv.verify()
    for face in bm.faces:
        dominant = max(range(3), key=lambda axis: abs(face.normal[axis]))
        u_axis, v_axis = ((1, 2), (0, 2), (0, 1))[dominant]
        for loop in face.loops:
            loop[uv_layer].uv = (loop.vert.co[u_axis], loop.vert.co[v_axis])


def finish_object(name, bm, materials, collection, shade_angle=None, recalc_normals=True):
    """Write `bm` to a new mesh object whose origin is its bounding-box centre."""
    if recalc_normals:
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    add_box_uvs(bm)
    center = Vector()
    if bm.verts:
        lo = Vector([min(v.co[i] for v in bm.verts) for i in range(3)])
        hi = Vector([max(v.co[i] for v in bm.verts) for i in range(3)])
        center = (lo + hi) / 2.0
        bmesh.ops.translate(bm, vec=-center, verts=bm.verts[:])

    mesh = bpy.data.meshes.new(name)
    bm.to_mesh(mesh)
    bm.free()
    for material in materials:
        mesh.materials.append(material)
    if shade_angle is not None:
        apply_hard_surface_shading(mesh, shade_angle)

    obj = bpy.data.objects.new(name, mesh)
    obj.location = center
    collection.objects.link(obj)
    return obj


# =============================================================================
# Modifiers
# =============================================================================
def add_modifier(obj, mod_type, name, **props):
    """Add a modifier through the data API, skipping properties a given
    Blender version does not expose instead of raising."""
    modifier = obj.modifiers.new(name=name, type=mod_type)
    for key, value in props.items():
        if not hasattr(modifier, key):
            log(f"{obj.name}: {mod_type} has no '{key}' in this Blender version; skipped")
            continue
        try:
            setattr(modifier, key, value)
        except (TypeError, ValueError, AttributeError) as exc:
            log(f"{obj.name}: could not set {name}.{key}: {exc}")
    return modifier


def add_bevel(obj, width, segments=3, angle_deg=30.0):
    return add_modifier(
        obj, "BEVEL", "Bevel",
        width=width, segments=segments, limit_method="ANGLE",
        angle_limit=math.radians(angle_deg), harden_normals=True,
        miter_outer="MITER_ARC", use_clamp_overlap=True,
    )


# =============================================================================
# Curves (built as curve data, then converted to mesh via the depsgraph)
# =============================================================================
def fillet_path(points, radius, steps=6):
    """Round every interior corner of a polyline with a quadratic Bezier."""
    pts = [Vector(p) for p in points]
    result = [pts[0]]
    for prev, corner, nxt in zip(pts, pts[1:], pts[2:]):
        incoming, outgoing = corner - prev, nxt - corner
        r = min(radius, incoming.length * 0.45, outgoing.length * 0.45)
        start = corner - incoming.normalized() * r
        end = corner + outgoing.normalized() * r
        for step in range(steps + 1):
            t = step / steps
            result.append(start.lerp(corner, t).lerp(corner.lerp(end, t), t))
    result.append(pts[-1])
    return result


def build_tubes(name, paths, base_radius, material, collection, resolution=4):
    """`paths` = [(points, radius_scale), ...] -> one mesh object of round tubes."""
    curve = bpy.data.curves.new(name, type="CURVE")
    curve.dimensions = "3D"
    curve.bevel_depth = base_radius
    curve.bevel_resolution = resolution
    curve.use_fill_caps = True
    curve.materials.append(material)
    for points, radius_scale in paths:
        spline = curve.splines.new("POLY")
        spline.points.add(len(points) - 1)
        for point, co in zip(spline.points, points):
            point.co = (co[0], co[1], co[2], 1.0)
            point.radius = radius_scale
        spline.use_smooth = True

    curve_obj = bpy.data.objects.new(f"{name}_curve", curve)
    collection.objects.link(curve_obj)
    depsgraph = bpy.context.evaluated_depsgraph_get()
    mesh = bpy.data.meshes.new_from_object(curve_obj.evaluated_get(depsgraph))
    mesh.name = name
    bpy.data.objects.remove(curve_obj, do_unlink=True)
    bpy.data.curves.remove(curve)
    if len(mesh.materials) == 0:
        mesh.materials.append(material)

    obj = bpy.data.objects.new(name, mesh)
    collection.objects.link(obj)
    return obj


def points_along(path, spacing):
    """Evenly spaced points (end points included) along an XZ polyline."""
    pts = [Vector(p) for p in path]
    lengths = [(b - a).length for a, b in zip(pts, pts[1:])]
    total = sum(lengths)
    count = max(2, round(total / spacing) + 1)
    result = []
    for k in range(count):
        remaining = total * k / (count - 1)
        for a, b, length in zip(pts, pts[1:], lengths):
            if remaining <= length + 1e-9:
                result.append(tuple(a.lerp(b, remaining / length if length else 0.0)))
                break
            remaining -= length
        else:
            result.append(tuple(pts[-1]))
    return result


# =============================================================================
# Layout helpers
# =============================================================================
def rib_positions():
    return [RIB_FIRST_Y + i * RIB_SPACING for i in range(RIB_COUNT)]


def wall_bays():
    """Y spans of bare wall between the back bulkhead, the ribs and the door."""
    bays, start = [], Y_START
    for rib_y in rib_positions():
        bays.append((start, rib_y - RIB_DEPTH / 2.0))
        start = rib_y + RIB_DEPTH / 2.0
    bays.append((start, Y_DOOR - 0.07))
    return bays


# =============================================================================
# Builders
# =============================================================================
def build_shell(ctx):
    """Corridor skin (trench floor, walls, chamfered ceiling) + end caps."""
    mats, col = ctx["mats"], ctx["col"]
    bm = bmesh.new()
    profile = shell_profile()
    y0, y1 = Y_START - 0.2, SHELL_Y_END
    front = [bm.verts.new((x, y0, z)) for x, z in profile]
    back = [bm.verts.new((x, y1, z)) for x, z in profile]
    for i in range(len(profile)):
        j = (i + 1) % len(profile)
        # Counter-clockwise profile + this winding = normals facing inward.
        face = bm.faces.new((front[i], front[j], back[j], back[i]))
        mid_z = (profile[i][1] + profile[j][1]) / 2.0
        if mid_z <= FLOOR_CHAMFER:
            face.material_index = 1          # trench floor
        elif mid_z > CEIL_Z - CEIL_CHAMFER:
            face.material_index = 2          # ceiling + chamfers
        else:
            face.material_index = 0          # walls
    shell = finish_object("Airlock_Shell", bm, [mats["steel"], mats["trench"], mats["ceiling"]], col,
                          recalc_normals=False)
    add_modifier(shell, "SOLIDIFY", "Solidify", thickness=0.12, offset=-1.0, use_even_offset=True)

    bm = bmesh.new()
    bm_prism(bm, shell_profile(0.05), Y_START - 0.15, Y_START)
    finish_object("Airlock_BackBulkhead", bm, [mats["steel"]], col)

    # Ceiling spine beam carrying the key-light housing.
    bm = bmesh.new()
    bm_box(bm, -0.18, 0.18, Y_START - 0.05, Y_DOOR + 0.02, CEIL_Z - 0.08, CEIL_Z + 0.01)
    bm_box(bm, -0.16, 0.16, -2.58, -2.40, 3.40, 3.48)
    spine = finish_object("Airlock_CeilingSpine", bm, [mats["steel"]], col, shade_angle=30)
    add_bevel(spine, 0.008, 2)


def build_ribs(ctx):
    """Heavy chamfered arch bulkheads with a protruding flange and bolt heads."""
    mats, col = ctx["mats"], ctx["col"]
    outer = shell_profile(0.1)  # buried in the solidified shell
    inner = chamfered_rect(-1.24, 1.24, -0.03, 3.20, 0.02, 0.62)
    lip_outer = chamfered_rect(-1.32, 1.32, -0.10, 3.28, 0.02, 0.66)
    lip_inner = chamfered_rect(-1.21, 1.21, -0.05, 3.17, 0.02, 0.60)
    bolt_line = [(-1.41, 0.65), (-1.41, 2.81), (-0.805, 3.415),
                 (0.805, 3.415), (1.41, 2.81), (1.41, 0.65)]
    bolts = points_along(bolt_line, 0.42)

    bm_ribs, bm_lips, bm_bolts = bmesh.new(), bmesh.new(), bmesh.new()
    for rib_y in rib_positions():
        y_front, y_back = rib_y - RIB_DEPTH / 2.0, rib_y + RIB_DEPTH / 2.0
        bm_ring(bm_ribs, outer, inner, y_front, y_back)
        bm_ring(bm_lips, lip_outer, lip_inner, y_front - RIB_LIP, y_back + RIB_LIP)
        for bx, bz in bolts:
            bm_prism(bm_bolts, hexagon(bx, bz, 0.028), y_front - 0.02, y_front + 0.005)

    ribs = finish_object("Airlock_Ribs", bm_ribs, [mats["steel"]], col, shade_angle=30)
    add_bevel(ribs, 0.03, 3)
    lips = finish_object("Airlock_RibFlanges", bm_lips, [mats["steel"]], col, shade_angle=30)
    add_bevel(lips, 0.012, 3)
    finish_object("Airlock_RibBolts", bm_bolts, [mats["chrome"]], col, shade_angle=30)


def build_grate(ctx):
    """Perforated chrome floor panels (one panel tiled with Array modifiers),
    panel frames and the I-beam / cross-bar support structure."""
    mats, col = ctx["mats"], ctx["col"]
    panels_x, panels_y = 2, 6
    gap, frame_w = 0.006, 0.025
    panel_w = (2.0 * GRATE_HALF_W - gap * (panels_x - 1)) / panels_x
    panel_l = (Y_DETAIL_END - Y_START - gap * (panels_y - 1)) / panels_y
    x0, y0 = -GRATE_HALF_W, Y_START

    def tile(obj):
        add_modifier(obj, "ARRAY", "Array_Y", count=panels_y, use_relative_offset=False,
                     use_constant_offset=True, constant_offset_displace=(0.0, panel_l + gap, 0.0))
        add_modifier(obj, "ARRAY", "Array_X", count=panels_x, use_relative_offset=False,
                     use_constant_offset=True, constant_offset_displace=(panel_w + gap, 0.0, 0.0))

    # Perforated plate: grid -> inset every cell -> delete the cell centres.
    bm = bmesh.new()
    gx0, gx1 = x0 + frame_w - 0.004, x0 + panel_w - frame_w + 0.004
    gy0, gy1 = y0 + frame_w - 0.004, y0 + panel_l - frame_w + 0.004
    cells_x, cells_y = 22, 8
    rows = [
        [bm.verts.new((gx0 + (gx1 - gx0) * i / cells_x, gy0 + (gy1 - gy0) * j / cells_y, GRATE_TOP_Z))
         for i in range(cells_x + 1)]
        for j in range(cells_y + 1)
    ]
    cells = [
        bm.faces.new((rows[j][i], rows[j][i + 1], rows[j + 1][i + 1], rows[j + 1][i]))
        for j in range(cells_y) for i in range(cells_x)
    ]
    bmesh.ops.inset_individual(bm, faces=cells, thickness=0.009, depth=0.0, use_even_offset=True)
    bmesh.ops.delete(bm, geom=cells, context="FACES_ONLY")
    plate = finish_object("Airlock_GratePlates", bm, [mats["chrome"]], col, recalc_normals=False)
    add_modifier(plate, "SOLIDIFY", "Solidify", thickness=GRATE_THICKNESS, offset=-1.0,
                 use_even_offset=True, use_rim=True)
    tile(plate)

    # Panel frame, 3 mm proud of the plate.
    bm = bmesh.new()
    fz0, fz1 = GRATE_TOP_Z - 0.035, GRATE_TOP_Z + 0.003
    bm_box(bm, x0, x0 + frame_w, y0, y0 + panel_l, fz0, fz1)
    bm_box(bm, x0 + panel_w - frame_w, x0 + panel_w, y0, y0 + panel_l, fz0, fz1)
    bm_box(bm, x0 + frame_w, x0 + panel_w - frame_w, y0, y0 + frame_w, fz0, fz1)
    bm_box(bm, x0 + frame_w, x0 + panel_w - frame_w, y0 + panel_l - frame_w, y0 + panel_l, fz0, fz1)
    frame = finish_object("Airlock_GrateFrames", bm, [mats["chrome"]], col, shade_angle=30)
    add_bevel(frame, 0.003, 2)
    tile(frame)

    # Supports: three I-beam stringers along Y plus cross bars under panel seams.
    bm = bmesh.new()
    sy0, sy1 = Y_START - 0.05, Y_DOOR + 0.02
    for sx in (-1.155, 0.0, 1.155):
        bm_box(bm, sx - 0.035, sx + 0.035, sy0, sy1, 0.436, 0.464)  # top flange
        bm_box(bm, sx - 0.007, sx + 0.007, sy0, sy1, 0.29, 0.44)    # web
        bm_box(bm, sx - 0.035, sx + 0.035, sy0, sy1, 0.272, 0.30)   # bottom flange
    for k in range(1, panels_y):
        seam_y = y0 + k * (panel_l + gap) - gap / 2.0
        bm_box(bm, -GRATE_HALF_W, GRATE_HALF_W, seam_y - 0.025, seam_y + 0.025, 0.44, 0.462)
    supports = finish_object("Airlock_GrateSupports", bm, [mats["trench"]], col, shade_angle=30)
    add_bevel(supports, 0.003, 1)


def build_floor_edges(ctx):
    """Side curbs between grating and walls, each with a recessed cyan groove."""
    mats, col = ctx["mats"], ctx["col"]
    y0, y1 = Y_START - 0.05, Y_DOOR + 0.02
    profile = [(1.20, 0.36), (1.505, 0.36), (1.505, 0.505), (1.34, 0.505),
               (1.34, 0.47), (1.26, 0.47), (1.26, 0.505), (1.20, 0.505)]
    bm = bmesh.new()
    for side in (-1.0, 1.0):
        bm_prism(bm, [(side * x, z) for x, z in profile], y0, y1)
        bm_box(ctx["accent"], side * 1.275, side * 1.325, y0, y1, 0.465, 0.478)
        # Continuous groove strip along the wall, between lower and upper panels.
        bm_box(ctx["accent"], side * (HALF_W - 0.025), side * (HALF_W + 0.005), y0, y1, 1.065, 1.095)
    curbs = finish_object("Airlock_FloorCurbs", bm, [mats["steel"]], col, shade_angle=30)
    add_bevel(curbs, 0.004, 2)


def build_wall_panels(ctx):
    """Modular side panels: a vented kick panel and a tall upper panel per bay,
    each with stepped inset recesses.  The gap between them is the cyan groove."""
    mats, col = ctx["mats"], ctx["col"]
    bm = bmesh.new()
    for side in (-1.0, 1.0):
        x_front, x_back = side * PANEL_FRONT_X, side * (HALF_W + 0.01)
        face_key = "+X" if side < 0 else "-X"   # face pointing into the corridor
        for bay_start, bay_end in wall_bays():
            y0, y1 = bay_start + 0.03, bay_end - 0.03
            if y1 - y0 < 0.2:
                continue
            upper = bm_box(bm, x_front, x_back, y0, y1, 1.14, 2.92)
            recess = inset_extrude(bm, upper[face_key], 0.04, -0.018)
            inset_extrude(bm, recess, 0.035, 0.008)

            lower = bm_box(bm, x_front, x_back, y0, y1, 0.56, 1.02)
            inset_extrude(bm, lower[face_key], 0.035, -0.014)
            for k in range(4):
                z = 0.64 + k * 0.09
                bm_box(bm, side * (PANEL_FRONT_X + 0.003), side * (PANEL_FRONT_X + 0.016),
                       y0 + 0.055, y1 - 0.055, z, z + 0.022)

    # Control box with a cyan status screen on the right wall, near the door.
    bm_box(bm, 1.36, 1.47, 0.90, 1.14, 1.36, 1.66)
    bm_box(ctx["accent"], 1.352, 1.362, 0.93, 1.11, 1.42, 1.62)

    panels = finish_object("Airlock_WallPanels", bm, [mats["steel"]], col, shade_angle=30)
    add_bevel(panels, 0.005, 2)


def conduit_path(side, y):
    """Up the wall from the trench, over the ceiling chamfer, into the spine."""
    d = HALF_W - CONDUIT_X
    k = math.sqrt(2.0) - 1.0
    corner_z = CEIL_Z - CEIL_CHAMFER - d * k
    corner_x = HALF_W - CEIL_CHAMFER - d * k
    return fillet_path([
        (side * CONDUIT_X, y, 0.08),
        (side * CONDUIT_X, y, corner_z),
        (side * corner_x, y, CEIL_Z - d),
        (side * 0.17, y, CEIL_Z - d),
    ], radius=0.15)


def build_conduits(ctx):
    """Vertical conduit pairs (curves -> mesh) with clamp brackets per bay."""
    mats, col = ctx["mats"], ctx["col"]
    paths = []
    bm = bmesh.new()
    for side in (-1.0, 1.0):
        for bay_start, bay_end in wall_bays():
            if bay_end - bay_start < 0.8:
                continue
            yc = (bay_start + bay_end) / 2.0
            paths.append((conduit_path(side, yc - 0.07), 1.0))
            paths.append((conduit_path(side, yc + 0.07), 0.016 / 0.022))
            for zb in (0.80, 1.70, 2.55):
                bm_box(bm, side * (CONDUIT_X - 0.03), side * (PANEL_FRONT_X - 0.005),
                       yc - 0.12, yc + 0.12, zb - 0.02, zb + 0.02)
            bm_box(bm, side * 0.52, side * 0.58, yc - 0.12, yc + 0.12, CEIL_Z - 0.11, CEIL_Z + 0.005)
    build_tubes("Airlock_Conduits", paths, 0.022, mats["chrome"], col)
    brackets = finish_object("Airlock_ConduitBrackets", bm, [mats["steel"]], col, shade_angle=30)
    add_bevel(brackets, 0.003, 2)


def build_trench(ctx):
    """Sub-floor: cyan grooves, pipes with flanges, cable bundles, saddles."""
    mats, col = ctx["mats"], ctx["col"]
    y0, y1 = Y_START - 0.05, Y_DOOR + 0.02
    bm = bmesh.new()
    for cx in (-0.35, 0.35):
        for rail_x in (cx - 0.055, cx + 0.055):
            bm_box(bm, rail_x - 0.01, rail_x + 0.01, y0, y1, -0.01, 0.035)
        bm_box(ctx["accent"], cx - 0.025, cx + 0.025, y0, y1, -0.01, 0.012)
    for px in (-0.78, 0.78):
        for sy in (-3.4, -2.1, -0.7, 0.7, 1.7):
            bm_box(bm, px - 0.09, px + 0.09, sy - 0.04, sy + 0.04, -0.01, 0.05)
    fixtures = finish_object("Airlock_TrenchFixtures", bm, [mats["trench"]], col, shade_angle=30)
    add_bevel(fixtures, 0.004, 2)

    pipes = []
    for px in (-0.78, 0.78):
        pipes.append(([(px, y0, 0.10), (px, Y_DOOR + 0.25, 0.10)], 1.0))
        for fy in (-3.0, -1.0, 1.0):
            pipes.append(([(px, fy - 0.03, 0.10), (px, fy + 0.03, 0.10)], 1.3))
    build_tubes("Airlock_TrenchPipes", pipes, 0.07, mats["steel"], col, resolution=6)

    cables = []
    bundle = [(1.00, 0.017), (1.04, 0.017), (1.08, 0.017), (1.02, 0.048), (1.06, 0.048)]
    for side in (-1.0, 1.0):
        for index, (cx, cz) in enumerate(bundle):
            phase = index * 1.7 + (0.0 if side < 0 else 0.9)
            segments = 24
            points = []
            for k in range(segments + 1):
                y = y0 + (Y_DOOR + 0.25 - y0) * k / segments
                points.append((side * cx + 0.006 * math.sin(2.1 * y + phase), y,
                               cz + 0.004 * math.sin(1.3 * y + phase)))
            cables.append((points, 1.0))
    build_tubes("Airlock_TrenchCables", cables, 0.016, mats["rubber"], col, resolution=3)


def build_door(ctx):
    """Octagonal blast door: bulkhead wall, chrome trim, split leaves with
    stepped recesses, locking hub, warning indicators.  Returns the trim (DOF target)."""
    mats, col = ctx["mats"], ctx["col"]
    c = DOOR_CENTER_Z

    bm = bmesh.new()
    bm_ring(bm, shell_profile(0.06), octagon(OPENING_APOTHEM, c), Y_DOOR, Y_DOOR + DOOR_WALL_DEPTH)
    wall = finish_object("Airlock_DoorBulkhead", bm, [mats["steel"]], col, shade_angle=30)
    add_bevel(wall, 0.025, 3)

    bm = bmesh.new()
    bm_ring(bm, octagon(TRIM_OUTER_APOTHEM, c), octagon(TRIM_INNER_APOTHEM, c), Y_DOOR - 0.07, Y_DOOR + 0.03)
    trim = finish_object("Airlock_DoorTrim", bm, [mats["chrome"]], col, shade_angle=30)
    add_bevel(trim, 0.012, 3)

    # Two leaves split down the middle.  Each leaf is one object carrying its
    # half of the hub, locks and indicators, so it can slide open as a unit
    # (material slots: 0 steel, 1 chrome, 2 indicator, 3 warning).
    leaf_materials = [mats["steel"], mats["chrome"], mats["indicator"], mats["warning"]]
    for suffix, side in (("L", -1.0), ("R", 1.0)):
        bm = bmesh.new()
        with MaterialSlot(bm, 0):
            parts = bm_prism(bm, half_octagon(DOOR_APOTHEM, c, side), DOOR_Y_FRONT, DOOR_Y_BACK)
            recess = inset_extrude(bm, parts["front"], 0.07, -0.025)
            inset_extrude(bm, recess, 0.055, 0.012)
        with MaterialSlot(bm, 1):
            parts = bm_prism(bm, half_octagon(0.34, c, side), DOOR_Y_FRONT - 0.09, DOOR_Y_FRONT + 0.03)
            recess = inset_extrude(bm, parts["front"], 0.05, -0.02)
            inset_extrude(bm, recess, 0.04, 0.01)
            for zc in (c - 1.0, c - 0.62, c + 0.62, c + 1.0):
                bm_box(bm, side * DOOR_SEAM, side * 0.12, DOOR_Y_FRONT - 0.05, DOOR_Y_FRONT + 0.01,
                       zc - 0.07, zc + 0.07)
        with MaterialSlot(bm, 2):
            bm_prism(bm, half_octagon_ring(0.44, 0.385, c, side), DOOR_Y_FRONT - 0.025, DOOR_Y_FRONT + 0.03)
        with MaterialSlot(bm, 3):
            bm_box(bm, side * 0.47, side * 0.63, DOOR_Y_FRONT - 0.012, DOOR_Y_FRONT + 0.02,
                   c + 0.83, c + 0.87)
        leaf = finish_object(f"Airlock_DoorLeaf_{suffix}", bm, leaf_materials, col, shade_angle=30)
        add_bevel(leaf, 0.006, 3)
        leaf.location.x += side * DOOR_SLIDE * DOOR_OPEN_FRACTION

    bm = bmesh.new()
    bm_box(bm, -GRATE_HALF_W, GRATE_HALF_W, Y_DETAIL_END, CHAMBER_Y0 - 0.03, 0.445, 0.497)
    threshold = finish_object("Airlock_DoorThreshold", bm, [mats["chrome"]], col, shade_angle=30)
    add_bevel(threshold, 0.005, 2)

    # Warning beacon housings, upper corners of the bulkhead.
    bm = bmesh.new()
    for side in (-1.0, 1.0):
        bm_box(bm, side * 1.10, side * 1.30, Y_DOOR - 0.10, Y_DOOR + 0.01, 2.85, 3.00)
    beacons = finish_object("Airlock_WarningBeacons", bm, [mats["steel"]], col, shade_angle=30)
    add_bevel(beacons, 0.006, 2)

    # Red emitters on the bulkhead: header strip, diagonal chevrons, beacon lenses.
    warn = ctx["warning"]
    strip_y0, strip_y1 = Y_DOOR - 0.025, Y_DOOR + 0.01
    for side in (-1.0, 1.0):
        bm_bar_xz(warn, (side * 1.395, 2.433), (side * 0.683, 3.145), 0.035, strip_y0, strip_y1)
        bm_bar_xz(warn, (side * 0.89, 0.562), (side * 1.40, 1.072), 0.035, strip_y0, strip_y1)
        bm_box(warn, side * 1.13, side * 1.27, Y_DOOR - 0.115, Y_DOOR - 0.095, 2.875, 2.975)
    bm_box(warn, -0.45, 0.45, strip_y0, strip_y1, 3.26, 3.30)
    return trim  # origin sits at the door centre -> depth-of-field target


def hazard_stripes(bm_yellow, bm_black, x0, x1, y0, y1, width=0.12):
    """Yellow floor band with 45 degree black stripes clipped to its rectangle."""
    z = GRATE_TOP_Z
    bm_box(bm_yellow, x0, x1, y0, y1, z - 0.01, z + 0.002)
    rect = [(x0, y0), (x1, y0), (x1, y1), (x0, y1)]
    start = x0 + y0 - 2.0 * width
    while start < x1 + y1:
        stripe = clip_polygon(rect, 1.0, 1.0, start + width)
        stripe = clip_polygon(stripe, -1.0, -1.0, -start)
        stripe = [p for p, q in zip(stripe, stripe[1:] + stripe[:1])
                  if abs(p[0] - q[0]) + abs(p[1] - q[1]) > 1e-6]
        if len(stripe) >= 3:
            bm_prism_z(bm_black, stripe, z - 0.008, z + 0.004)
        start += 2.0 * width


def upper_diagonal_bar(bm, side, s0, s1, depth, y0, y1):
    """Block lying on an upper diagonal wall panel of the module (side -1 left,
    +1 right), from fraction s0 to s1 down the panel and `depth` deep."""
    a, c = CHAMBER_APOTHEM, DOOR_CENTER_Z
    t = a * TAN_22_5

    def along(s):
        return Vector((side * (t + (a - t) * s), c + a - (a - t) * s))

    offset = Vector((-side, -1.0)).normalized() * (depth / 2.0 - 0.02)
    return bm_bar_xz(bm, along(s0) + offset, along(s1) + offset, depth, y0, y1)


def build_equipment_lock(ctx):
    """Equipment lock between the blast door and the hatch bulkhead: stowage
    rack, strapped cargo bags, ceiling light panels and handrails.  The spare
    suit on its stand and the loose floating items are added by the viewer."""
    mats, col = ctx["mats"], ctx["col"]
    c = DOOR_CENTER_Z
    y0, y1 = CHAMBER_Y0, HATCH_WALL_Y0
    ceil_z = c + CHAMBER_APOTHEM

    # Shell in two bays split by a slim trim frame; the ceiling stays flat for the lights.
    bm = bmesh.new()
    for seg_start, seg_end in ((y0, EQUIP_SEAM_Y), (EQUIP_SEAM_Y, y1 + 0.01)):
        parts = bm_ring(bm, octagon(CHAMBER_OUTER_APOTHEM, c), octagon(CHAMBER_APOTHEM, c),
                        seg_start, seg_end)
        for edge_index in (2, 3, 5, 6):
            recess = inset_extrude(bm, parts["inner"][edge_index], 0.14, -0.03)
            inset_extrude(bm, recess, 0.05, 0.012)
    shell = finish_object("Equip_Shell", bm, [mats["chamber_white"]], col, shade_angle=30)
    add_bevel(shell, 0.006, 2)

    bm = bmesh.new()
    bm_ring(bm, octagon(1.5, c), octagon(1.40, c), EQUIP_SEAM_Y - 0.05, EQUIP_SEAM_Y + 0.05)
    frame = finish_object("Equip_SeamFrame", bm, [mats["steel"]], col, shade_angle=30)
    add_bevel(frame, 0.01, 2)

    # Floor plate, hazard bands at the blast door and at the hatch, cyan edge strips.
    hw = CHAMBER_FLOOR_HALF_W
    bm = bmesh.new()
    bm_box(bm, -hw, hw, y0 - 0.04, y1 + 0.01, GRATE_TOP_Z - 0.08, GRATE_TOP_Z)
    finish_object("Equip_Floor", bm, [mats["trench"]], col)
    hazard_stripes(ctx["hazard_yellow"], ctx["hazard_black"], -0.72, 0.72, y0 + 0.05, y0 + 0.45)
    hazard_stripes(ctx["hazard_yellow"], ctx["hazard_black"], -0.72, 0.72, y1 - 0.42, y1 - 0.04)
    for side in (-1.0, 1.0):
        bm_box(ctx["accent"], side * 0.74, side * 0.77, y0 + 0.55, y1 - 0.52,
               GRATE_TOP_Z - 0.005, GRATE_TOP_Z + 0.004)

    # Two ceiling light panels, clear of the seam frame.
    bm = bmesh.new()
    for ya, yb in ((2.78, 3.55), (3.95, 4.72)):
        bm_box(bm, -0.3, 0.3, ya - 0.03, yb + 0.03, ceil_z - 0.05, ceil_z + 0.01)
        bm_box(ctx["equip_light"], -0.26, 0.26, ya, yb, ceil_z - 0.056, ceil_z - 0.045)
    housings = finish_object("Equip_LightHousings", bm, [mats["steel"]], col, shade_angle=30)
    add_bevel(housings, 0.006, 2)

    # Handrails: two along the ceiling (broken at the seam frame) and vertical
    # grab bars either side of the hatch on both faces of the bulkhead.
    rails = []
    rail_z = ceil_z - 0.075
    for x in (-0.47, 0.47):
        for start, end in ((2.8, 3.6), (3.9, 4.7)):
            rails.append((fillet_path([
                (x, start, ceil_z + 0.01), (x, start + 0.08, rail_z),
                (x, end - 0.08, rail_z), (x, end, ceil_z + 0.01),
            ], radius=0.05), 1.0))
    for face_y, standoff in ((HATCH_WALL_Y0, -0.07), (HATCH_WALL_Y1, 0.07)):
        inside = face_y - math.copysign(0.01, standoff)
        for x in (-0.82, 0.82):
            rails.append((fillet_path([
                (x, inside, 1.0), (x, face_y + standoff, 1.08),
                (x, face_y + standoff, 2.42), (x, inside, 2.5),
            ], radius=0.05), 1.0))
    build_tubes("Equip_Handrails", rails, 0.018, mats["chrome"], col)

    # Stowage rack on the right wall: carcass plus 2 x 4 labelled drawers.
    rx0, ry0, ry1, rz0, rz1 = 1.2, 2.95, 4.15, 1.0, 2.5
    bm = bmesh.new()
    bm_box(bm, rx0, CHAMBER_APOTHEM + 0.02, ry0, ry1, rz0, rz1)
    rack = finish_object("Equip_StowageRack", bm, [mats["steel"]], col, shade_angle=30)
    add_bevel(rack, 0.008, 2)

    bm_fronts, bm_handles, bm_labels = bmesh.new(), bmesh.new(), bmesh.new()
    gap = 0.02
    drawer_w = (ry1 - ry0 - 3.0 * gap) / 2.0
    drawer_h = (rz1 - rz0 - 5.0 * gap) / 4.0
    for column in range(2):
        ya = ry0 + gap + column * (drawer_w + gap)
        ym = ya + drawer_w / 2.0
        for row in range(4):
            za = rz0 + gap + row * (drawer_h + gap)
            front = bm_box(bm_fronts, rx0 - 0.025, rx0 + 0.001, ya, ya + drawer_w, za, za + drawer_h)
            inset_extrude(bm_fronts, front["-X"], 0.025, -0.006)
            zh = za + drawer_h - 0.06
            bm_box(bm_handles, rx0 - 0.05, rx0 - 0.035, ym - 0.09, ym + 0.09, zh - 0.012, zh + 0.004)
            for yh in (ym - 0.08, ym + 0.08):
                bm_box(bm_handles, rx0 - 0.04, rx0 - 0.02, yh - 0.008, yh + 0.008, zh - 0.01, zh + 0.002)
            bm_box(bm_labels, rx0 - 0.0225, rx0 - 0.015, ya + 0.05, ya + 0.17, za + 0.04, za + 0.08)
    fronts = finish_object("Equip_RackDrawers", bm_fronts, [mats["ceiling"]], col, shade_angle=30)
    add_bevel(fronts, 0.004, 2)
    finish_object("Equip_RackHandles", bm_handles, [mats["chrome"]], col, shade_angle=30)
    finish_object("Equip_RackLabels", bm_labels, [mats["cargo"]], col, shade_angle=30)

    # Soft cargo transfer bags strapped to the upper diagonal panels.
    bm_bags, bm_straps = bmesh.new(), bmesh.new()
    for side, s0, s1, ya, yb in ((-1.0, 0.12, 0.88, 2.72, 3.3), (1.0, 0.12, 0.62, 2.98, 3.62),
                                 (1.0, 0.15, 0.88, 4.28, 4.86)):
        upper_diagonal_bar(bm_bags, side, s0, s1, 0.24, ya, yb)
        for ys in (ya + 0.12, yb - 0.15):
            upper_diagonal_bar(bm_straps, side, s0 - 0.03, s1 + 0.03, 0.25, ys, ys + 0.03)
    bags = finish_object("Equip_CargoBags", bm_bags, [mats["cargo"]], col, shade_angle=40)
    add_bevel(bags, 0.035, 3)
    finish_object("Equip_CargoStraps", bm_straps, [mats["strap"]], col, shade_angle=30)


def hatch_outline(grow=0.0):
    """Hatch opening in the bulkhead (8 points, so it bridges to an octagon)."""
    return chamfered_rect(-HATCH_HALF_W - grow, HATCH_HALF_W + grow, GRATE_TOP_Z - 0.03 - grow,
                          HATCH_TOP_Z + grow, 0.03, HATCH_TOP_CHAMFER + grow * 0.41)


def hatch_leaf_outline(side):
    """One closed hatch leaf (side = +1 right, -1 left), split at x = +-DOOR_SEAM."""
    x1 = HATCH_HALF_W + HATCH_LEAF_OVERLAP
    z0, z1 = GRATE_TOP_Z, HATCH_TOP_Z + HATCH_LEAF_OVERLAP
    ct = HATCH_TOP_CHAMFER + HATCH_LEAF_OVERLAP * 0.41
    right = [(DOOR_SEAM, z0), (x1, z0), (x1, z1 - ct), (x1 - ct, z1), (DOOR_SEAM, z1)]
    return right if side > 0 else [(-x, z) for x, z in reversed(right)]


def build_hatch(ctx):
    """Bulkhead between the equipment lock and the crew lock with a two-leaf
    sliding pressure hatch; the leaves slide sideways into the bulkhead."""
    mats, col = ctx["mats"], ctx["col"]
    c = DOOR_CENTER_Z
    y0, y1 = HATCH_WALL_Y0, HATCH_WALL_Y1

    bm = bmesh.new()
    bm_ring(bm, octagon(CHAMBER_OUTER_APOTHEM, c), hatch_outline(), y0, y1)
    wall = finish_object("Hatch_Bulkhead", bm, [mats["chamber_white"]], col, shade_angle=30)
    add_bevel(wall, 0.01, 2)

    # Dark frame round the opening on both faces (5 mm lip), chrome threshold plate.
    bm = bmesh.new()
    for ya, yb in ((y0 - 0.035, y0 + 0.01), (y1 - 0.01, y1 + 0.035)):
        bm_ring(bm, hatch_outline(0.13), hatch_outline(-0.005), ya, yb)
    trim = finish_object("Hatch_Trim", bm, [mats["steel"]], col, shade_angle=30)
    add_bevel(trim, 0.008, 2)

    bm = bmesh.new()
    bm_box(bm, -HATCH_HALF_W - 0.02, HATCH_HALF_W + 0.02, y0 - 0.02, y1 + 0.02,
           GRATE_TOP_Z - 0.06, GRATE_TOP_Z + 0.003)
    threshold = finish_object("Hatch_Threshold", bm, [mats["chrome"]], col, shade_angle=30)
    add_bevel(threshold, 0.004, 2)

    # Leaves: painted panel with recesses on both faces, a steel seam rail and
    # grab handles, an indicator strip (recoloured by the viewer) and hazard chevrons.
    leaf_materials = [mats["ceiling"], mats["steel"], mats["hatch_indicator"], mats["hazard"]]
    yf, yb = HATCH_LEAF_Y0, HATCH_LEAF_Y1
    faces = ((yf, -1.0), (yb, 1.0))   # (face plane, outward direction along Y)
    for suffix, side in (("L", -1.0), ("R", 1.0)):
        bm = bmesh.new()
        with MaterialSlot(bm, 0):
            parts = bm_prism(bm, hatch_leaf_outline(side), yf, yb)
            for key in ("front", "back"):
                recess = inset_extrude(bm, parts[key], 0.07, -0.012)
                inset_extrude(bm, recess, 0.045, 0.006)
        with MaterialSlot(bm, 1):
            bm_box(bm, side * DOOR_SEAM, side * 0.075, yf - 0.014, yb + 0.014, 0.52, HATCH_TOP_Z + 0.02)
            for face_y, out in faces:
                bar_y = face_y + out * 0.045
                bm_box(bm, side * 0.2, side * 0.4, bar_y - 0.008, bar_y + 0.008, 1.37, 1.4)
                for xh in (0.215, 0.385):
                    bm_box(bm, side * (xh - 0.01), side * (xh + 0.01), face_y - out * 0.015, bar_y,
                           1.372, 1.398)
        with MaterialSlot(bm, 2):
            for face_y, out in faces:
                bm_box(bm, side * 0.11, side * 0.47, face_y - out * 0.008, face_y + out * 0.01, 2.27, 2.3)
        with MaterialSlot(bm, 3):
            for face_y, out in faces:
                ya, yb2 = sorted((face_y - out * 0.008, face_y + out * 0.004))
                for k in range(4):
                    xa = 0.12 + k * 0.11
                    bm_bar_xz(bm, (side * xa, 0.56), (side * (xa + 0.07), 0.7), 0.035, ya, yb2)
        leaf = finish_object(f"Hatch_Leaf_{suffix}", bm, leaf_materials, col, shade_angle=30)
        add_bevel(leaf, 0.005, 2)
        leaf.location.x += side * HATCH_SLIDE * HATCH_OPEN_FRACTION

    # Status lamps above the opening on both faces (same material as the leaf strips).
    bm_housing, bm_lens = bmesh.new(), bmesh.new()
    for face_y, out in ((y0, -1.0), (y1, 1.0)):
        for side in (-1.0, 1.0):
            bm_box(bm_housing, side * 0.38, side * 0.54, face_y - out * 0.01, face_y + out * 0.035, 2.93, 3.03)
            bm_box(bm_lens, side * 0.4, side * 0.52, face_y + out * 0.034, face_y + out * 0.04, 2.95, 3.01)
    housing = finish_object("Hatch_LampHousings", bm_housing, [mats["steel"]], col, shade_angle=30)
    add_bevel(housing, 0.005, 2)
    finish_object("Hatch_StatusLamps", bm_lens, [mats["hatch_indicator"]], col)


def build_inner_chamber(ctx):
    """Crew lock: bright octagonal decontamination chamber behind the hatch
    bulkhead, closed by an outer hatch with a porthole looking out into space."""
    mats, col = ctx["mats"], ctx["col"]
    c = DOOR_CENTER_Z
    y0, y1 = CREW_Y0, CHAMBER_Y1
    ring_half = 0.1

    # Shell: ring segments joined under the decon frames.  Wall, upper
    # diagonal and ceiling faces (loop edges 2..6) get stepped panel recesses.
    bm = bmesh.new()
    cuts = [y0 - 0.01, *CHAMBER_RING_YS, y1 + 0.05]
    for seg_start, seg_end in zip(cuts, cuts[1:]):
        parts = bm_ring(bm, octagon(CHAMBER_OUTER_APOTHEM, c), octagon(CHAMBER_APOTHEM, c),
                        seg_start, seg_end)
        for edge_index in (2, 3, 4, 5, 6):
            recess = inset_extrude(bm, parts["inner"][edge_index], 0.14, -0.03)
            inset_extrude(bm, recess, 0.05, 0.012)
    shell = finish_object("Chamber_Shell", bm, [mats["chamber_white"]], col, shade_angle=30)
    add_bevel(shell, 0.006, 2)

    # Decon frames (dark steel) with an emissive band on their inner edge.
    bm = bmesh.new()
    for ring_y in CHAMBER_RING_YS:
        bm_ring(bm, octagon(1.5, c), octagon(1.30, c), ring_y - ring_half, ring_y + ring_half)
        bm_ring(ctx["chamber_light"], octagon(1.31, c), octagon(1.285, c), ring_y - 0.05, ring_y + 0.05)
    frames = finish_object("Chamber_DeconFrames", bm, [mats["steel"]], col, shade_angle=30)
    add_bevel(frames, 0.012, 3)

    # Floor plate, hazard bands at both ends, cyan edge strips.
    hw = CHAMBER_FLOOR_HALF_W
    bm = bmesh.new()
    bm_box(bm, -hw, hw, y0 - 0.01, y1 + 0.02, GRATE_TOP_Z - 0.08, GRATE_TOP_Z)
    finish_object("Chamber_Floor", bm, [mats["trench"]], col)
    hazard_stripes(ctx["hazard_yellow"], ctx["hazard_black"], -0.72, 0.72, y0 + 0.05, y0 + 0.45)
    hazard_stripes(ctx["hazard_yellow"], ctx["hazard_black"], -0.72, 0.72, y1 - 0.55, y1 - 0.08)
    for side in (-1.0, 1.0):
        bm_box(ctx["accent"], side * 0.74, side * 0.77, y0 + 0.55, y1 - 0.65,
               GRATE_TOP_Z - 0.005, GRATE_TOP_Z + 0.004)

    # Handrails on the side walls, broken around the decon frames.
    rail_x, rail_z, wall_x = CHAMBER_APOTHEM - 0.07, 1.35, CHAMBER_APOTHEM + 0.04
    stops = [y0 + 0.03, *CHAMBER_RING_YS, y1 - 0.03]
    spans = [(start + 0.22, end - 0.22) for start, end in zip(stops, stops[1:])]
    rails = []
    for side in (-1.0, 1.0):
        for start, end in spans:
            rails.append((fillet_path([
                (side * wall_x, start, rail_z), (side * rail_x, start + 0.08, rail_z),
                (side * rail_x, end - 0.08, rail_z), (side * wall_x, end, rail_z),
            ], radius=0.06), 1.0))
    build_tubes("Chamber_Handrails", rails, 0.018, mats["chrome"], col)

    # Outer hatch wall: octagon with a circular porthole, bridged quad-for-quad.
    bm = bmesh.new()
    bm_ring(bm, resample_closed(octagon(CHAMBER_OUTER_APOTHEM, c), 3), circle(0.30, c, 24), y1, y1 + 0.15)
    finish_object("Chamber_HatchWall", bm, [mats["steel"]], col, shade_angle=30)

    bm = bmesh.new()
    with MaterialSlot(bm, 0):
        bm_ring(bm, resample_closed(octagon(1.02, c), 3), circle(0.40, c, 24), y1 - 0.035, y1 + 0.01)
    with MaterialSlot(bm, 1):
        bm_ring(bm, octagon(1.12, c), octagon(1.01, c), y1 - 0.06, y1 + 0.01)
        bm_ring(bm, circle(0.41, c, 24), circle(0.29, c, 24), y1 - 0.08, y1 + 0.02)
        for k in range(8):
            angle = math.radians(22.5 + 45.0 * k)
            bm_prism(bm, hexagon(0.75 * math.cos(angle), c + 0.75 * math.sin(angle), 0.035),
                     y1 - 0.055, y1 - 0.02)
    hatch = finish_object("Chamber_OuterHatch", bm, [mats["steel"], mats["chrome"]], col, shade_angle=30)
    add_bevel(hatch, 0.006, 2)

    bm = bmesh.new()
    bm_prism(bm, circle(0.299, c, 24), y1 + 0.07, y1 + 0.075)
    finish_object("Chamber_PortholeGlass", bm, [mats["glass"]], col)

    for side in (-1.0, 1.0):
        for dz in (0.92, -0.92):
            bm_box(ctx["warning"], side * 0.88, side * 0.96, y1 - 0.03, y1 + 0.01, c + dz - 0.04, c + dz + 0.04)


def build_space(ctx):
    """Planet and star field outside the porthole (seen with real parallax)."""
    import random

    from mathutils import Matrix

    mats, col = ctx["mats"], ctx["col"]
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=64, v_segments=32, radius=5.0,
                              matrix=Matrix.Translation((2.0, CHAMBER_Y1 + 28.0, 0.8)))
    planet = finish_object("Space_Planet", bm, [mats["planet"]], col, recalc_normals=False)
    apply_hard_surface_shading(planet.data, 180.0)

    rng = random.Random(7)
    bm = bmesh.new()
    for _ in range(700):
        # Random direction inside a 40 degree cone around +Y, 45-60 m away.
        yaw = math.radians(rng.uniform(-40.0, 40.0))
        pitch = math.radians(rng.uniform(-30.0, 30.0))
        distance = rng.uniform(45.0, 60.0)
        center = Vector((math.sin(yaw) * math.cos(pitch), math.cos(yaw) * math.cos(pitch),
                         math.sin(pitch))) * distance + Vector((0.0, CHAMBER_Y1, DOOR_CENTER_Z))
        size = rng.uniform(0.04, 0.12)
        tips = [bm.verts.new(center + Vector(offset) * size) for offset in
                ((1, 0, 0), (-1, 0, 0), (0, 1, 0), (0, -1, 0), (0, 0, 1), (0, 0, -1))]
        px, nx, py, ny, pz, nz = tips
        for a, b in ((px, py), (py, nx), (nx, ny), (ny, px)):
            bm.faces.new((a, b, pz))
            bm.faces.new((b, a, nz))
    finish_object("Space_Stars", bm, [mats["stars"]], col)


# =============================================================================
# Lights and camera
# =============================================================================
def aim(obj, target):
    direction = Vector(target) - obj.location
    obj.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()


def add_light(collection, name, light_type, location, energy, radius, color=(1.0, 1.0, 1.0),
              kelvin=None, target=None, spot_size_deg=None, spot_blend=None):
    data = bpy.data.lights.new(name, type=light_type)
    data.energy = energy
    data.shadow_soft_size = radius  # "Radius" in the UI; tiny = razor-sharp shadows
    if kelvin is not None and hasattr(data, "use_temperature"):
        data.use_temperature = True
        data.temperature = kelvin
        data.color = (1.0, 1.0, 1.0)
    elif kelvin is not None:
        data.color = kelvin_to_rgb(kelvin)
    else:
        data.color = color[:3]
    if light_type == "SPOT":
        data.spot_size = math.radians(spot_size_deg)
        data.spot_blend = spot_blend
        data.show_cone = True

    obj = bpy.data.objects.new(name, data)
    obj.location = location
    collection.objects.link(obj)
    if target is not None:
        aim(obj, target)
    return obj


def build_lights(ctx):
    col = ctx["col"]
    # Key: ceiling-mounted, raking forward so the ribs throw hard bands of shadow.
    add_light(col, "Airlock_Key_Spot", "SPOT", (0.0, -2.33, 3.33), 1200.0, 0.01,
              kelvin=6500, target=(0.0, 2.0, 1.2), spot_size_deg=45.0, spot_blend=0.05)
    # Warning rim: just in front of the right beacon lens, grazing the door frame.
    add_light(col, "Airlock_Warning_Rim", "POINT", (1.2, Y_DOOR - 0.2, 2.925), 250.0, 0.01,
              color=hex_to_rgba("#FF3300"))
    # Trench up-lights: point straight up through the perforated grating to
    # project its hole pattern onto the walls and ceiling.  The grating is
    # magnified ~9x on the ceiling, so the radius must stay ~1 mm for the grid
    # edges to stay crisp.
    for index, (x, y) in enumerate(((0.35, -2.6), (-0.35, -0.7), (0.35, 1.2)), start=1):
        add_light(col, f"Airlock_Trench_Uplight_{index}", "SPOT", (x, y, 0.12), 150.0, 0.001,
                  color=(0.25, 0.85, 1.0), target=(x, y, 5.0), spot_size_deg=120.0, spot_blend=0.1)
    # Module fill: warm panels in the equipment lock, cool light in the crew lock.
    for index, y in enumerate((3.15, 4.35), start=1):
        add_light(col, f"Equip_Light_{index}", "POINT", (0.0, y, 2.9), 45.0, 0.05, kelvin=5000)
    bays = [(a + b) / 2.0 for a, b in zip(CHAMBER_RING_YS, CHAMBER_RING_YS[1:])]
    for index, y in enumerate((CREW_Y0 + 0.5, *bays, CHAMBER_Y1 - 0.6), start=1):
        add_light(col, f"Chamber_Light_{index}", "POINT", (0.0, y, 2.85), 60.0, 0.05, kelvin=6500)


def build_camera(scene, ctx, focus_target):
    data = bpy.data.cameras.new("Airlock_Camera")
    data.lens = CAMERA_LENS_MM
    data.sensor_width = 36.0
    data.clip_start = 0.05
    data.clip_end = 200.0
    data.dof.use_dof = True
    data.dof.focus_object = focus_target
    data.dof.focus_distance = (focus_target.location - Vector(CAMERA_LOCATION)).length
    data.dof.aperture_fstop = CAMERA_FSTOP

    camera = bpy.data.objects.new("Airlock_Camera", data)
    camera.location = CAMERA_LOCATION
    ctx["col"].objects.link(camera)
    aim(camera, focus_target.location)
    scene.camera = camera
    return camera


# =============================================================================
# Entry point
# =============================================================================
def main():
    scene = bpy.context.scene
    ensure_object_mode()
    clear_scene(scene)
    device = configure_render(scene)
    look = configure_color_management(scene)
    configure_world(scene)

    ctx = {
        "col": get_build_collection(scene),
        "mats": build_materials(),
        # Emitters are collected across builders and merged into one object each.
        "accent": bmesh.new(),
        "warning": bmesh.new(),
        "chamber_light": bmesh.new(),
        "equip_light": bmesh.new(),
        "hazard_yellow": bmesh.new(),
        "hazard_black": bmesh.new(),
    }
    build_shell(ctx)
    build_ribs(ctx)
    build_grate(ctx)
    build_floor_edges(ctx)
    build_wall_panels(ctx)
    build_conduits(ctx)
    build_trench(ctx)
    door_trim = build_door(ctx)
    build_equipment_lock(ctx)
    build_hatch(ctx)
    build_inner_chamber(ctx)
    build_space(ctx)
    mats, col = ctx["mats"], ctx["col"]
    finish_object("Airlock_AccentStrips", ctx["accent"], [mats["accent"]], col)
    finish_object("Airlock_WarningLights", ctx["warning"], [mats["warning"]], col)
    finish_object("Chamber_RingLights", ctx["chamber_light"], [mats["chamber_light"]], col)
    finish_object("Equip_LightPanels", ctx["equip_light"], [mats["equip_light"]], col)
    finish_object("Chamber_HazardYellow", ctx["hazard_yellow"], [mats["hazard"]], col)
    finish_object("Chamber_HazardBlack", ctx["hazard_black"], [mats["rubber"]], col)
    build_lights(ctx)
    build_camera(scene, ctx, door_trim)

    log(f"render device: {device}")
    log(f"colour management: AgX / {look or 'default look'} / exposure -0.5")
    log(f"built {len(ctx['col'].objects)} objects in collection '{COLLECTION_NAME}'")


if __name__ == "__main__":
    main()
