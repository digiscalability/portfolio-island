 = 'd:\GitHUB\Build Project Ready for Deployment\Island.ts'
 = Get-Content -Path  -Raw
 = [string]::Join( 
, @(
'      // Combine layers for natural variation',
'      const displacement = largeTerrain + mediumTerrain + smallDetail + microNoise;',
'',
'      const newPos = normal.multiplyScalar(this.radius + displacement);'
))
 = [string]::Join(
, @(
'      // Combine layers for natural variation',
'      const displacement = largeTerrain + mediumTerrain + smallDetail + microNoise;',
'',
'      const rawRadius = this.radius + displacement;',
'      const minRadius = this.radius * 0.94;',
'      const maxRadius = this.radius + 3.8;',
'      const finalRadius = THREE.MathUtils.clamp(rawRadius, minRadius, maxRadius);',
'      const newPos = normal.multiplyScalar(finalRadius);'
))
 = .Replace(.Replace(
, 
), .Replace(
, 
))
[IO.File]::WriteAllText(, )
