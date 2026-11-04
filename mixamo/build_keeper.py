"""Merge Mixamo FBX downloads into one animated GLB for the penalty scene.

Put these in this folder (FBX Binary, 30 fps, "With Skin", In Place OFF):
    idle.fbx        Goalkeeper Idle            (required, used as the base mesh + skeleton)
    dive_low.fbx    a low / along-the-ground diving save
    dive_high.fbx   a high / top-corner diving save
    catch.fbx       Goalkeeper Catch (central shots)
Any other *.fbx here is added too, named after its file.

Run:
    blender -b --python build_keeper.py
Output:
    ../assets/goalkeeper_rigged_raw.glb  (then compressed by build_keeper.sh)
"""
import bpy
import os

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "assets", "goalkeeper_rigged_raw.glb")
ORDER = ["idle", "sidestep", "dive_mid", "dive_low", "jump_high", "catch_high", "catch_mid"]

bpy.ops.wm.read_factory_settings(use_empty=True)

files = {os.path.splitext(f)[0]: os.path.join(HERE, f) for f in os.listdir(HERE) if f.lower().endswith(".fbx")}
files.pop("goalkeeper_for_mixamo", None)
if "idle" not in files:
    raise SystemExit("idle.fbx is required (download Goalkeeper Idle 'With Skin')")
names = [n for n in ORDER if n in files] + sorted(n for n in files if n not in ORDER)

base_arm = None
actions = []
for name in names:
    before = set(bpy.data.objects)
    bpy.ops.import_scene.fbx(filepath=files[name], use_anim=True, ignore_leaf_bones=True)
    new = [o for o in bpy.data.objects if o not in before]
    arm = next(o for o in new if o.type == "ARMATURE")
    act = arm.animation_data.action if arm.animation_data else None
    if act is None:
        print(f"!! {name}: no animation found, skipped")
    else:
        act.name = name
        act.use_fake_user = True
        actions.append(act)
        print(f"   {name}: {act.frame_range[1] - act.frame_range[0]:.0f} frames")
    if base_arm is None:
        base_arm = arm
    else:
        for o in new:
            bpy.data.objects.remove(o, do_unlink=True)

# one NLA track per clip so the exporter writes each as its own animation
ad = base_arm.animation_data or base_arm.animation_data_create()
for act in actions:
    track = ad.nla_tracks.new()
    track.name = act.name
    strip = track.strips.new(act.name, int(act.frame_range[0]), act)
    if hasattr(strip, "action_slot") and act.slots:
        strip.action_slot = act.slots[0]
    track.mute = False
ad.action = None

# Mixamo sometimes drops the texture; restore it from the original Sketchfab GLB if so
src = os.environ.get("KEEPER_SOURCE_GLB", "/tmp/gk/source/model.glb")
meshes = [o for o in bpy.data.objects if o.type == "MESH"]
has_tex = any(
    n.type == "TEX_IMAGE" and n.image
    for o in meshes for s in o.material_slots if s.material and s.material.use_nodes
    for n in s.material.node_tree.nodes
)
if not has_tex and os.path.exists(src):
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=src)
    imported = [o for o in bpy.data.objects if o not in before]
    mat = next(o.active_material for o in imported if o.type == "MESH" and o.active_material)
    for o in meshes:
        o.data.materials.clear()
        o.data.materials.append(mat)
    for o in imported:
        bpy.data.objects.remove(o, do_unlink=True)
    print("   restored texture from original GLB")

# keep only the skeleton and the meshes it drives (drops bone-display shapes, cameras, lights)
for o in list(bpy.data.objects):
    skinned = o.type == "MESH" and any(m.type == "ARMATURE" and m.object == base_arm for m in o.modifiers)
    if o is not base_arm and not skinned:
        bpy.data.objects.remove(o, do_unlink=True)

bpy.ops.export_scene.gltf(
    filepath=OUT,
    export_format="GLB",
    export_animations=True,
    export_animation_mode="NLA_TRACKS",
    export_force_sampling=True,
    export_skins=True,
    export_morph=False,
    export_apply=False,
)
print("WROTE", OUT)
