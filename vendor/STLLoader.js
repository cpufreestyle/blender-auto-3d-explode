/**
 * STL Loader (精简版)
 * 从 Three.js examples 提取，支持二进制和 ASCII STL 格式
 */
import * as THREE from './three.module.js';

class STLLoader {
  parse(data) {
    const isBinary = this._isBinary(data);
    return isBinary ? this._parseBinary(data) : this._parseASCII(data);
  }

  _isBinary(data) {
    const reader = new DataView(data);
    const faceSize = 32 / 8 + 32 / 8 * 3 + 32 / 8 * 3 * 3 + 16 / 8;
    const nFaces = reader.getUint32(80, true);
    const expectedSize = 80 + 4 + nFaces * faceSize;

    if (expectedSize === reader.byteLength) return true;

    // Check for ASCII header
    const solidStr = 'solid';
    for (let i = 0; i < 5; i++) {
      if (reader.getUint8(i) !== solidStr.charCodeAt(i)) return true;
    }
    return false;
  }

  _parseBinary(data) {
    const reader = new DataView(data);
    const faces = reader.getUint32(80, true);

    let dataOffset = 84;
    const faceLength = 50;

    const positions = new Float32Array(faces * 3 * 3);
    const normals = new Float32Array(faces * 3 * 3);

    for (let face = 0; face < faces; face++) {
      const start = dataOffset + face * faceLength;
      const normalX = reader.getFloat32(start, true);
      const normalY = reader.getFloat32(start + 4, true);
      const normalZ = reader.getFloat32(start + 8, true);

      for (let i = 1; i <= 3; i++) {
        const vertexstart = start + i * 12;
        const componentIdx = face * 9 + (i - 1) * 3;

        positions[componentIdx] = reader.getFloat32(vertexstart, true);
        positions[componentIdx + 1] = reader.getFloat32(vertexstart + 4, true);
        positions[componentIdx + 2] = reader.getFloat32(vertexstart + 8, true);

        normals[componentIdx] = normalX;
        normals[componentIdx + 1] = normalY;
        normals[componentIdx + 2] = normalZ;
      }
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    return geometry;
  }

  _parseASCII(data) {
    const text = new TextDecoder().decode(data);
    const patternSolid = /solid([\s\S]*?)endsolid/g;
    const patternFace = /facet([\s\S]*?)endfacet/g;
    const patternNormal = /normal[\s]+([\-+]?[0-9]+\.?[0-9]*([eE][\-+]?[0-9]+)?)+[\s]+([\-+]?[0-9]+\.?[0-9]*([eE][\-+]?[0-9]+)?)+[\s]+([\-+]?[0-9]+\.?[0-9]*([eE][\-+]?[0-9]+)?)+/g;
    const patternVertex = /vertex[\s]+([\-+]?[0-9]+\.?[0-9]*([eE][\-+]?[0-9]+)?)+[\s]+([\-+]?[0-9]+\.?[0-9]*([eE][\-+]?[0-9]+)?)+[\s]+([\-+]?[0-9]+\.?[0-9]*([eE][\-+]?[0-9]+)?)+/g;

    const positions = [];
    const normals = [];

    let result;
    while ((result = patternFace.exec(text)) !== null) {
      const faceText = result[0];
      const normalMatch = patternNormal.exec(faceText);
      let nx = 0, ny = 0, nz = 0;
      if (normalMatch) {
        nx = parseFloat(normalMatch[1]);
        ny = parseFloat(normalMatch[3]);
        nz = parseFloat(normalMatch[5]);
      }

      let vResult;
      patternVertex.lastIndex = 0;
      let vCount = 0;
      while ((vResult = patternVertex.exec(faceText)) !== null && vCount < 3) {
        positions.push(parseFloat(vResult[1]), parseFloat(vResult[3]), parseFloat(vResult[5]));
        normals.push(nx, ny, nz);
        vCount++;
      }
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
    return geometry;
  }
}

export { STLLoader };
