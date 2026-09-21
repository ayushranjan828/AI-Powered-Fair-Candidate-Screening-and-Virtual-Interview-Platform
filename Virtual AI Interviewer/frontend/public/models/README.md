# Avatar models

Drop a realistic chimpanzee/monkey GLB here as:

    realistic-monkey.glb

and it is picked up on the next page load. Nothing else needs changing: the
path lives in `src/avatar/config.js` only, and the app falls back to the
built-in sculpted rig when the file is absent.

## What the loader expects

* **GLB (or glTF), head-and-shoulders or full body.** The model is measured and
  scaled automatically so the head lands in the portrait crop - author at any
  scale. The fit uses, in order of preference: the distance between the eye
  bones, the head bone, then the bounding box.
* **Draco / Meshopt / KTX2 are all supported.** Decoders are served from
  `public/vendor/` and are only fetched if the model actually uses them.
* **Blendshapes are optional but recommended.** ARKit names work
  (`jawOpen`, `eyeBlinkLeft`, `mouthSmileLeft`, `browInnerUp`, ...), as do
  Oculus/Ready-Player-Me visemes (`viseme_aa`, `viseme_O`, ...) and a number of
  looser spellings - matching ignores case and punctuation. See
  `src/avatar/morph-map.js` for the full alias table.
* **Bones are optional.** A bone named like `Head`, `Neck`, `LeftEye`,
  `RightEye` or `Jaw` will be driven for head turns, gaze and jaw drop. Naming
  follows the usual conventions (`mixamorig:Head`, `eye_L`, ...).
* **Animation clips are optional.** A clip whose name contains `idle` plays on
  a loop; one containing `talk` is recognised for future use.

Anything the model does not carry is simply not driven - a model with no
blendshapes still turns its head, tracks with its eyes and animates its clip.

## Budget

This runs in a browser next to a live interview. Aim for:

* under ~15 MB for the GLB (Draco or Meshopt geometry, KTX2 textures)
* textures at 2K or less; 1K is plenty at this crop
* one or two materials for the character

## Overrides

Set these on `window` before the bundle loads (e.g. in the HTML head):

```html
<script>
  window.AVATAR_MODEL_URL = "/static/models/other-model.glb";
  // Skip the automatic fit if you have authored to our units already:
  window.AVATAR_MODEL_FIT = { scale: 1, x: 0, y: 0, z: 0 };
</script>
```

`Avatar.describe()` in the browser console reports which rig is live, which
morph channels resolved, and how the model was fitted.
