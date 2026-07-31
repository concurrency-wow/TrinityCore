"use client";

import { useEffect, useRef } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

export default function ModelViewer({ url }: { url: string }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x10151a);
    const camera = new THREE.PerspectiveCamera(35, 1, 0.01, 1000);
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    el.appendChild(renderer.domElement);
    scene.add(new THREE.HemisphereLight(0xfff1cf, 0x334455, 2.2));
    const key = new THREE.DirectionalLight(0xffc45b, 3);
    key.position.set(3, 5, 4);
    scene.add(key);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    let mixer: THREE.AnimationMixer | undefined;
    new GLTFLoader().load(url, (gltf) => {
      scene.add(gltf.scene);
      const box = new THREE.Box3().setFromObject(gltf.scene);
      const size = box.getSize(new THREE.Vector3());
      const center = box.getCenter(new THREE.Vector3());
      controls.target.copy(center);
      camera.position.set(center.x + size.length() * .7, center.y + size.y * .25, center.z + size.length() * .7);
      camera.near = Math.max(size.length() / 1000, .01);
      camera.far = size.length() * 100;
      camera.updateProjectionMatrix();
      if (gltf.animations.length) { mixer = new THREE.AnimationMixer(gltf.scene); mixer.clipAction(gltf.animations[0]).play(); }
    });
    const clock = new THREE.Clock();
    let frame = 0;
    const resize = () => { const w=el.clientWidth,h=el.clientHeight; renderer.setSize(w,h,false); camera.aspect=w/h;camera.updateProjectionMatrix(); };
    const animate = () => { frame=requestAnimationFrame(animate);resize();mixer?.update(clock.getDelta());controls.update();renderer.render(scene,camera); };
    animate();
    return () => { cancelAnimationFrame(frame); controls.dispose(); renderer.dispose(); el.replaceChildren(); };
  }, [url]);
  return <div className="model-canvas" ref={host} />;
}
