uniform vec3 color;
uniform vec3 lightDirection;
varying vec3 vNormal;
varying vec3 vViewPosition;

void main() {
  vec3 normal = normalize(vNormal);
  vec3 lightDir = normalize(lightDirection);
  
  // Calculate diffuse lighting
  float diff = max(dot(normal, lightDir), 0.0);
  
  // Quantize to 3 levels for toon shading
  float toonDiff;
  if (diff > 0.7) {
    toonDiff = 1.0;
  } else if (diff > 0.3) {
    toonDiff = 0.6;
  } else {
    toonDiff = 0.3;
  }
  
  vec3 finalColor = color * toonDiff;
  gl_FragColor = vec4(finalColor, 1.0);
}

