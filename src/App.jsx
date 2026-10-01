import { Canvas } from '@react-three/fiber';
import { Suspense, useEffect, useMemo, useState } from 'react';
import * as THREE from 'three';
import { KnowledgeScene } from './components/scene/KnowledgeScene.jsx';
import { CameraController } from './components/scene/CameraController.jsx';
import { SearchBar } from './components/ui/SearchBar.jsx';
import { useKnowledgeStore } from './store/knowledgeStore.js';
import { CAMERA_FOV } from './utils/sceneLayout.js';
import { startUrlSync } from './utils/urlSync.js';
import { COLORS } from './utils/palette.js';
import { startFullscreenLandscape, watchRotation } from './utils/screenRotation.js';

export default function App() {
  const initialClear = useMemo(() => new THREE.Color(COLORS.bg), []);
  // A screen taller than it is wide shows the one landscape layout on its side.
  const [rotated, setRotated] = useState(false);
  useEffect(() => watchRotation(setRotated), []);
  useEffect(() => startFullscreenLandscape(), []);

  useEffect(() => {
    useKnowledgeStore.getState().loadRoots();
    const stopUrlSync = startUrlSync();
    const onKey = (e) => {
      if (e.key === 'Escape') useKnowledgeStore.getState().resetView();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      stopUrlSync();
      window.removeEventListener('keydown', onKey);
    };
  }, []);

  return (
    <div className={`app ${rotated ? 'is-rotated' : ''}`}>
      <div className="canvas-layer" style={{ background: COLORS.bg }}>
        <Canvas
          dpr={[1, 2]}
          // Layout size, not the bounding box, which a rotated page swaps.
          resize={{ offsetSize: true }}
          gl={{ antialias: true, alpha: false, powerPreference: 'high-performance' }}
          camera={{ position: [0, 0, 0.6], fov: CAMERA_FOV, near: 0.1, far: 200 }}
          onCreated={({ gl, scene }) => {
            gl.setClearColor(initialClear, 1);
            scene.background = initialClear;
          }}
        >
          <Suspense fallback={null}>
            <KnowledgeScene />
            <CameraController />
          </Suspense>
        </Canvas>
      </div>

      <SearchBar />
    </div>
  );
}
