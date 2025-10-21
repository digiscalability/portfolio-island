# downloads curated HDRIs and CC0 audio samples into ./assets/
param()

$files = @(
  @{ url = 'https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/1k/studio_small_02_1k.hdr'; out = 'assets/hdri_studio_small_02_1k.hdr'; type='direct'; license='CC0 (Poly Haven)'; note='Studio small 02 1k HDRI' },
  @{ url = 'https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/1k/studio_small_01_1k.hdr'; out = 'assets/hdri_studio_small_01_1k.hdr'; type='direct'; license='CC0 (Poly Haven)'; note='Studio small 01 1k HDRI' },
  @{ url = 'https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/1k/venice_sunset_1k.hdr'; out = 'assets/hdri_venice_sunset_1k.hdr'; type='direct'; license='CC0 (Poly Haven)'; note='Venice sunset 1k HDRI' },
  @{ url = 'https://interactive-examples.mdn.mozilla.net/media/cc0-audio/t-rex-roar.mp3'; out = 'assets/cc0_trex.mp3'; type='direct'; license='CC0 (MDN sample)'; note='Short CC0 audio sample' },
  # fallback audio - stable samplelib mirror
  @{ url = 'https://samplelib.com/lib/preview/mp3/sample-3s.mp3'; out = 'assets/cc0_sample_short.mp3'; type='direct'; license='Unknown (samplelib)'; note='Short sample clip' },
  @{ url = 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3'; out = 'assets/cc0_example_long.mp3'; type='direct'; license='Example (check site)'; note='Long example audio' }
)

# Curated CC0/permissive asset page links (manual download)
$curated = @(
  @{ url = 'https://polyhaven.com/hdris'; out = ''; type='page'; license='CC0'; note='Search Poly Haven for high-quality HDRIs (recommended).' },
  @{ url = 'https://polyhaven.com/textures'; out = ''; type='page'; license='CC0'; note='Poly Haven textures collection.' },
  @{ url = 'https://ambientcg.com/'; out = ''; type='page'; license='CC0'; note='ambientCG PBR materials (CC0) — great for albedo/normal/roughness maps.' },
  @{ url = 'https://kenney.nl/assets'; out = ''; type='page'; license='Varies (check pack)'; note='Kenney game asset packs (2D/3D kits) — many free packs.' },
  @{ url = 'https://opengameart.org/'; out = ''; type='page'; license='Varies (check asset)'; note='OpenGameArt — search for CC0/CC-BY assets.' },
  @{ url = 'https://sketchfab.com/search?features=downloadable&type=models&license=cc0'; out = ''; type='page'; license='CC0 (filter)'; note='Sketchfab downloadable models filtered by CC0.' }
)

# Suggested direct GLB model URLs (CC0 or permissively licensed). Replace or remove as needed.
$models = @(
  @{ url = 'https://kenney.nl/assets/1/3d/characters/blocky_character.glb'; out = 'assets/models/blocky_character.glb'; license='Kenney (check pack)'; note='Blocky character (placeholder)' },
  @{ url = 'https://cdn.jsdelivr.net/gh/KhronosGroup/glTF-Sample-Models/2.0/Avocado/glTF-Binary/Avocado.glb'; out = 'assets/models/avocado.glb'; license='Khronos sample' ; note='Sample model (for loader test)' },
  @{ url = 'https://cdn.jsdelivr.net/gh/KhronosGroup/glTF-Sample-Models/2.0/BoxTextured/glTF-Binary/BoxTextured.glb'; out = 'assets/models/box_textured.glb'; license='Khronos sample'; note='Box textured sample' },
  @{ url = 'https://cdn.jsdelivr.net/gh/KhronosGroup/glTF-Sample-Models/2.0/CesiumMilkTruck/glTF-Binary/CesiumMilkTruck.glb'; out = 'assets/models/milk_truck.glb'; license='Khronos sample'; note='Vehicle sample' },
  @{ url = 'https://cdn.jsdelivr.net/gh/KhronosGroup/glTF-Sample-Models/2.0/WaterBottle/glTF-Binary/WaterBottle.glb'; out = 'assets/models/water_bottle.glb'; license='Khronos sample'; note='Prop sample' },
  @{ url = 'https://cdn.jsdelivr.net/gh/KhronosGroup/glTF-Sample-Models/2.0/Monster/glTF-Binary/Monster.glb'; out = 'assets/models/monster.glb'; license='Khronos sample'; note='Character sample' },
  @{ url = 'https://cdn.jsdelivr.net/gh/KhronosGroup/glTF-Sample-Models/2.0/FlightHelmet/glTF-Binary/FlightHelmet.glb'; out = 'assets/models/flight_helmet.glb'; license='Khronos sample'; note='Helmet sample (stress test)' },
  @{ url = 'https://cdn.jsdelivr.net/gh/KhronosGroup/glTF-Sample-Models/2.0/BrainStem/glTF-Binary/BrainStem.glb'; out = 'assets/models/brainstem.glb'; license='Khronos sample'; note='Organic model sample' },
  @{ url = 'https://cdn.jsdelivr.net/gh/KhronosGroup/glTF-Sample-Models/2.0/2CylinderEngine/glTF-Binary/2CylinderEngine.glb'; out = 'assets/models/engine.glb'; license='Khronos sample'; note='Mechanical sample' },
  @{ url = 'https://cdn.jsdelivr.net/gh/KhronosGroup/glTF-Sample-Models/2.0/AnimatedCube/glTF-Binary/AnimatedCube.glb'; out = 'assets/models/animated_cube.glb'; license='Khronos sample'; note='Animated sample' }
)

# Suggested HDR direct URLs (Poly Haven CC0)
$hdrs = @(
  @{ url = 'https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/1k/studio_small_02_1k.hdr'; out = 'assets/hdri/studio_small_02_1k.hdr'; license='CC0 (Poly Haven)'; note='Studio small 02 1k' },
  @{ url = 'https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/1k/studio_small_01_1k.hdr'; out = 'assets/hdri/studio_small_01_1k.hdr'; license='CC0 (Poly Haven)'; note='Studio small 01 1k' },
  @{ url = 'https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/1k/venice_sunset_1k.hdr'; out = 'assets/hdri/venice_sunset_1k.hdr'; license='CC0 (Poly Haven)'; note='Venice sunset 1k' },
  @{ url = 'https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/1k/park_1k.hdr'; out = 'assets/hdri/park_1k.hdr'; license='CC0 (Poly Haven)'; note='Park 1k' },
  @{ url = 'https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/1k/studio_small_03_1k.hdr'; out = 'assets/hdri/studio_small_03_1k.hdr'; license='CC0 (Poly Haven)'; note='Studio small 03 1k' }
)

if (-not (Test-Path -Path 'assets/models')) { New-Item -ItemType Directory -Path 'assets/models' | Out-Null }
if (-not (Test-Path -Path 'assets/hdri')) { New-Item -ItemType Directory -Path 'assets/hdri' | Out-Null }

foreach ($m in $models) {
  if (Test-Path -Path $m.out) { Write-Host "Skipping existing model: $($m.out)"; continue }
  Write-Host "Downloading model $($m.url) -> $($m.out)"
  try { Invoke-WebRequest -Uri $m.url -OutFile $m.out -UseBasicParsing -TimeoutSec 180; Write-Host "Saved $($m.out)" } catch { Write-Warning "Failed to download model $($m.url) : $_" }
}

foreach ($h in $hdrs) {
  if (Test-Path -Path $h.out) { Write-Host "Skipping existing HDR: $($h.out)"; continue }
  Write-Host "Downloading HDR $($h.url) -> $($h.out)"
  try { Invoke-WebRequest -Uri $h.url -OutFile $h.out -UseBasicParsing -TimeoutSec 180; Write-Host "Saved $($h.out)" } catch { Write-Warning "Failed to download HDR $($h.url) : $_" }
}

if (-not (Test-Path -Path 'assets')) { New-Item -ItemType Directory -Path 'assets' | Out-Null }

foreach ($f in $files) {
  $url = $f.url
  $out = $f.out
  if (Test-Path -Path $out) {
    Write-Host "Skipping existing: $out"
    continue
  }
  Write-Host "Downloading $url -> $out"
  try {
    Invoke-WebRequest -Uri $url -OutFile $out -UseBasicParsing -TimeoutSec 120
    Write-Host "Saved $out"
  } catch {
    Write-Warning "Failed to download $url : $_"
  }
}

Write-Host 'Direct downloads finished. Verify files exist in ./assets/'

Write-Host "`nCurated sites (manual download recommended):"
foreach ($c in $curated) {
  Write-Host "- $($c.url) — $($c.note) — License: $($c.license)"
}

Write-Host "`nIf you want these pages scraped/automatically downloaded, ask me and I can add a Node downloader script that will fetch selectable items from these pages (you will run it locally)."
