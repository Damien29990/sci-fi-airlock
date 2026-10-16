"""
Build the airlock with scifi_airlock.py and export it as web/public/models/airlock.glb
for the three.js viewer.

    blender -b --python export_glb.py

Modifiers are applied on export.  Lights and the camera are exported too; the
viewer uses their positions and re-tunes intensities for real-time rendering.
Procedural shader nodes (the steel bump) do not survive glTF; the viewer adds
a tiling normal map instead, using the box-projected UVs the build script writes.
"""

import os
import runpy

import bpy

HERE = os.path.dirname(os.path.abspath(__file__))
OUTPUT = os.path.join(HERE, "web", "public", "models", "airlock.glb")


def main():
    runpy.run_path(os.path.join(HERE, "scifi_airlock.py"), run_name="__main__")
    os.makedirs(os.path.dirname(OUTPUT), exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=OUTPUT,
        export_format="GLB",
        export_apply=True,
        export_lights=True,
        export_cameras=True,
        export_yup=True,
        export_draco_mesh_compression_enable=True,
        export_draco_mesh_compression_level=6,
    )
    print(f"[SciFi Airlock] exported {OUTPUT} ({os.path.getsize(OUTPUT) / 1e6:.1f} MB)")


if __name__ == "__main__":
    main()
