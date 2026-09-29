import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import './App.css';
import { FALLBACK_MAP_CELLS, type MapCell } from './data/fallbackMapData';

interface TelemetryData {
  fps: number;
  FPS?: number;
  latency_ms: number;
  memory_gb: number;
  total_cells: string;
}

export default function App() {
  // Live State
  const [telemetry, setTelemetry] = useState<TelemetryData>({
    fps: 16.2,
    latency_ms: 58.0,
    memory_gb: 0.9,
    total_cells: '0.48 M',
  });
  const [cells, setCells] = useState<MapCell[]>(FALLBACK_MAP_CELLS);
  const [isConnected, setIsConnected] = useState<boolean>(false);
  const [isStreaming, setIsStreaming] = useState<boolean>(true);
  const [telemetryHistory, setTelemetryHistory] = useState<Array<{ fps: number; latency: number }>>(() =>
    Array.from({ length: 30 }, () => ({
      fps: 16.2 + (Math.random() * 0.6 - 0.3),
      latency: 58.0 + (Math.random() * 2.0 - 1.0),
    }))
  );

  // Panel Control States
  const [panel1View, setPanel1View] = useState<'3d' | 'top' | 'side'>('3d');
  const [panel2Filter, setPanel2Filter] = useState<'all' | 'vehicle' | 'pedestrian' | 'road' | 'vegetation' | 'building'>('all');
  const [panel4View, setPanel4View] = useState<'top' | '3d' | 'elevation'>('top');
  const [panel4Mode, setPanel4Mode] = useState<'elevation' | 'semantic'>('elevation');
  const [hoveredCell, setHoveredCell] = useState<MapCell | null>(null);
  const [tooltipPos, setTooltipPos] = useState<{ x: number; y: number } | null>(null);

  // Canvas Refs
  const canvas1Ref = useRef<HTMLCanvasElement | null>(null);
  const canvas2Ref = useRef<HTMLCanvasElement | null>(null);
  const canvas3Ref = useRef<HTMLCanvasElement | null>(null);
  const canvas4Ref = useRef<HTMLCanvasElement | null>(null);
  const sparklineRef = useRef<HTMLCanvasElement | null>(null);

  // Interactive 3D camera angles for Panel 1
  const camera1Ref = useRef({ yaw: 0.6, pitch: 0.45, zoom: 1.0, isDragging: false, lastX: 0, lastY: 0 });

  // 1. Live Data Fetching
  const fetchLiveData = useCallback(async () => {
    let telemetryOk = false;
    let mapOk = false;

    try {
      const resTel = await fetch('http://localhost:8000/api/telemetry', { signal: AbortSignal.timeout(1500) });
      if (resTel.ok) {
        const data = await resTel.json();
        setTelemetry({
          fps: data.fps ?? data.FPS ?? 16.2,
          latency_ms: data.latency_ms ?? 58.0,
          memory_gb: data.memory_gb ?? 0.9,
          total_cells: data.total_cells ?? '0.48 M',
        });
        setTelemetryHistory((prev) => [
          ...prev.slice(1),
          {
            fps: data.fps ?? data.FPS ?? 16.2,
            latency: data.latency_ms ?? 58.0,
          },
        ]);
        telemetryOk = true;
      }
    } catch {
      // Telemetry backend offline or waiting
    }

    try {
      const resMap = await fetch('http://localhost:8000/api/map-data', { signal: AbortSignal.timeout(2000) });
      if (resMap.ok) {
        const data = await resMap.json();
        if (Array.isArray(data) && data.length > 0) {
          setCells(data);
          mapOk = true;
        }
      }
    } catch {
      // Map data backend offline or waiting
    }

    setIsConnected(telemetryOk || mapOk);
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => {
      void fetchLiveData();
    }, 0);
    if (!isStreaming) return () => clearTimeout(timer);
    const interval = setInterval(() => {
      void fetchLiveData();
    }, 2000);
    return () => {
      clearTimeout(timer);
      clearInterval(interval);
    };
  }, [fetchLiveData, isStreaming]);

  // Synthetic subtle animation loop for radar/scanner
  const [animTick, setAnimTick] = useState<number>(0);
  useEffect(() => {
    let animId: number;
    const loop = () => {
      setAnimTick((t) => (t + 1) % 3600);
      animId = requestAnimationFrame(loop);
    };
    animId = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(animId);
  }, []);

  // Compute map bounds
  const mapBounds = useMemo(() => {
    if (cells.length === 0) {
      return { minX: 11, maxX: 61, minY: 8, maxY: 50, minZ: 0.7, maxZ: 1.6, spanX: 50, spanY: 42 };
    }
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const c of cells) {
      if (c.gx < minX) minX = c.gx;
      if (c.gx > maxX) maxX = c.gx;
      if (c.gy < minY) minY = c.gy;
      if (c.gy > maxY) maxY = c.gy;
      if (c.z_mean < minZ) minZ = c.z_mean;
      if (c.z_mean > maxZ) maxZ = c.z_mean;
    }
    return {
      minX,
      maxX,
      minY,
      maxY,
      minZ,
      maxZ,
      spanX: maxX - minX,
      spanY: maxY - minY,
    };
  }, [cells]);

  // Helper colormap
  const getElevationColor = (z: number, minZ: number, maxZ: number) => {
    const norm = Math.max(0, Math.min(1, (z - minZ) / (maxZ - minZ || 1)));
    if (norm < 0.25) return `rgba(2, 132, 199, ${0.7 + norm * 0.3})`; // Blue
    if (norm < 0.5) return `rgba(16, 185, 129, ${0.75 + (norm - 0.25) * 0.25})`; // Emerald
    if (norm < 0.75) return `rgba(250, 204, 21, ${0.8 + (norm - 0.5) * 0.2})`; // Yellow
    return `rgba(239, 68, 68, ${0.85 + (norm - 0.75) * 0.15})`; // Orange/Red
  };

  // -------------------------------------------------------------
  // PANEL 1: RAW LIDAR POINT CLOUD
  // -------------------------------------------------------------
  useEffect(() => {
    const canvas = canvas1Ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const width = (canvas.width = canvas.parentElement?.clientWidth || 400);
    const height = (canvas.height = canvas.parentElement?.clientHeight || 280);

    ctx.fillStyle = '#060911';
    ctx.fillRect(0, 0, width, height);

    const centerX = width / 2;
    const centerY = height / 2 + 10;
    const { yaw, pitch, zoom } = camera1Ref.current;
    const sweepAngle = (animTick * 0.05) % (Math.PI * 2);

    // Coordinate grid / ground rings
    ctx.lineWidth = 1;
    for (let r = 25; r <= 150; r += 30) {
      ctx.strokeStyle = 'rgba(30, 58, 100, 0.35)';
      ctx.beginPath();
      if (panel1View === 'top') {
        ctx.arc(centerX, centerY, r * zoom, 0, Math.PI * 2);
      } else if (panel1View === 'side') {
        ctx.ellipse(centerX, centerY, r * zoom, 12 * zoom, 0, 0, Math.PI * 2);
      } else {
        ctx.ellipse(centerX, centerY, r * zoom, r * 0.45 * zoom * Math.cos(pitch), 0, 0, Math.PI * 2);
      }
      ctx.stroke();
    }

    // LiDAR Sweep Cone
    ctx.save();
    ctx.translate(centerX, centerY);
    const beamGrad = ctx.createRadialGradient(0, 0, 5, 0, 0, 160 * zoom);
    beamGrad.addColorStop(0, 'rgba(56, 189, 248, 0.4)');
    beamGrad.addColorStop(1, 'rgba(56, 189, 248, 0.0)');
    ctx.fillStyle = beamGrad;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.arc(0, 0, 160 * zoom, sweepAngle - 0.25, sweepAngle + 0.25);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    // Generate LiDAR points (simulating 128-beam scan with obstacles & road)
    const numPoints = 320;
    for (let i = 0; i < numPoints; i++) {
      const ring = (i % 8) + 1;
      const angle = (i * 0.17) + (ring * 0.4);
      const dist = (ring * 16) + (Math.sin(i * 3) * 6);
      let px = Math.cos(angle) * dist;
      let py = Math.sin(angle) * dist;
      let pz = (Math.sin(angle * 2) * 5) - (dist * 0.05);

      // Add clustered vehicle obstacles
      if (i > 240 && i < 270) {
        px = 45 + (Math.cos(i) * 14);
        py = -55 + (Math.sin(i) * 10);
        pz = 15 + Math.sin(i * 4) * 6;
      } else if (i > 180 && i < 205) {
        px = -50 + (Math.cos(i) * 10);
        py = 20 + (Math.sin(i) * 8);
        pz = 12 + Math.sin(i * 5) * 5;
      }

      // Projection according to view
      let screenX = centerX;
      let screenY = centerY;
      const intensity = Math.min(1, Math.max(0.1, (pz + 10) / 25 + Math.sin(i) * 0.2));

      if (panel1View === 'top') {
        screenX = centerX + px * zoom;
        screenY = centerY + py * zoom;
      } else if (panel1View === 'side') {
        screenX = centerX + px * zoom;
        screenY = centerY - pz * 4 * zoom;
      } else {
        // 3D Orbit
        const rotX = px * Math.cos(yaw) - py * Math.sin(yaw);
        const rotY = px * Math.sin(yaw) + py * Math.cos(yaw);
        screenX = centerX + rotX * zoom;
        screenY = centerY + (rotY * Math.sin(pitch) - pz * Math.cos(pitch) * 2.2) * zoom;
      }

      // Color from intensity gradient (Blue -> Cyan -> Green -> Yellow -> Red)
      let color = '#38bdf8';
      if (intensity > 0.8) color = '#ef4444';
      else if (intensity > 0.6) color = '#f59e0b';
      else if (intensity > 0.4) color = '#10b981';
      else if (intensity > 0.2) color = '#06b6d4';
      else color = '#3b82f6';

      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(screenX, screenY, panel1View === '3d' ? 1.5 : 1.8, 0, Math.PI * 2);
      ctx.fill();
    }

    // Ego vehicle in center
    ctx.fillStyle = '#f8fafc';
    ctx.strokeStyle = '#38bdf8';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.roundRect(centerX - 6, centerY - 10, 12, 20, 3);
    ctx.fill();
    ctx.stroke();

    // Forward heading arrow
    ctx.strokeStyle = '#ef4444';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(centerX, centerY - 10);
    ctx.lineTo(centerX, centerY - 18);
    ctx.stroke();
  }, [animTick, panel1View]);

  // Mouse drag handler for Panel 1 3D orbit
  const handlePanel1MouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    camera1Ref.current.isDragging = true;
    camera1Ref.current.lastX = e.clientX;
    camera1Ref.current.lastY = e.clientY;
  };
  const handlePanel1MouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!camera1Ref.current.isDragging || panel1View !== '3d') return;
    const dx = e.clientX - camera1Ref.current.lastX;
    const dy = e.clientY - camera1Ref.current.lastY;
    camera1Ref.current.yaw += dx * 0.01;
    camera1Ref.current.pitch = Math.max(0.1, Math.min(1.2, camera1Ref.current.pitch + dy * 0.01));
    camera1Ref.current.lastX = e.clientX;
    camera1Ref.current.lastY = e.clientY;
  };
  const handlePanel1MouseUp = () => {
    camera1Ref.current.isDragging = false;
  };

  // -------------------------------------------------------------
  // PANEL 2: AI PERCEPTION (SEMANTIC SEGMENTATION)
  // -------------------------------------------------------------
  useEffect(() => {
    const canvas = canvas2Ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const width = (canvas.width = canvas.parentElement?.clientWidth || 400);
    const height = (canvas.height = canvas.parentElement?.clientHeight || 280);

    ctx.fillStyle = '#060911';
    ctx.fillRect(0, 0, width, height);

    const centerX = width / 2;
    const centerY = height / 2 + 10;

    // Road drivable corridor
    if (panel2Filter === 'all' || panel2Filter === 'road') {
      ctx.fillStyle = 'rgba(56, 189, 248, 0.12)';
      ctx.strokeStyle = 'rgba(56, 189, 248, 0.4)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(centerX - 45, height);
      ctx.lineTo(centerX - 25, 40);
      ctx.lineTo(centerX + 25, 40);
      ctx.lineTo(centerX + 45, height);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();

      // Road dash line
      ctx.strokeStyle = 'rgba(56, 189, 248, 0.6)';
      ctx.setLineDash([8, 8]);
      ctx.beginPath();
      ctx.moveTo(centerX, height);
      ctx.lineTo(centerX, 45);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Detected objects with 3D bounding boxes and confidence tags
    const objects = [
      { type: 'vehicle', name: 'Car', dist: '12.4m', conf: '99.2%', x: centerX + 45, y: centerY - 50, w: 32, h: 22, color: '#eab308' },
      { type: 'vehicle', name: 'Truck', dist: '28.5m', conf: '98.4%', x: centerX - 55, y: centerY - 85, w: 38, h: 28, color: '#eab308' },
      { type: 'pedestrian', name: 'Pedestrian', dist: '8.1m', conf: '97.8%', x: centerX - 38, y: centerY + 20, w: 14, h: 14, color: '#ef4444' },
      { type: 'vegetation', name: 'Tree/Bush', dist: '18.0m', conf: '96.5%', x: centerX + 75, y: centerY - 10, w: 26, h: 26, color: '#22c55e' },
      { type: 'vegetation', name: 'Tree', dist: '22.0m', conf: '95.9%', x: centerX - 80, y: centerY - 30, w: 24, h: 24, color: '#22c55e' },
      { type: 'building', name: 'Barrier', dist: '32.0m', conf: '99.0%', x: centerX + 85, y: centerY - 95, w: 40, h: 20, color: '#f97316' },
    ];

    for (const obj of objects) {
      if (panel2Filter !== 'all' && panel2Filter !== obj.type) continue;

      // Draw bounding box
      ctx.strokeStyle = obj.color;
      ctx.lineWidth = 1.5;
      ctx.fillStyle = `${obj.color}22`;

      ctx.beginPath();
      ctx.roundRect(obj.x - obj.w / 2, obj.y - obj.h / 2, obj.w, obj.h, 4);
      ctx.fill();
      ctx.stroke();

      // Top corner brackets for 3D AI detection look
      const bx = obj.x - obj.w / 2;
      const by = obj.y - obj.h / 2;
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(bx - 3, by + 4);
      ctx.lineTo(bx - 3, by - 3);
      ctx.lineTo(bx + 4, by - 3);
      ctx.stroke();

      // Label tag
      ctx.font = '10px var(--font-mono)';
      ctx.fillStyle = obj.color;
      ctx.fillText(`${obj.name} [${obj.dist}]`, obj.x - obj.w / 2, obj.y - obj.h / 2 - 5);
      ctx.fillStyle = '#94a3b8';
      ctx.font = '9px var(--font-mono)';
      ctx.fillText(`${obj.conf}`, obj.x - obj.w / 2, obj.y + obj.h / 2 + 11);
    }

    // PointNet++ confidence stamp
    ctx.fillStyle = 'rgba(15, 23, 42, 0.85)';
    ctx.strokeStyle = 'rgba(56, 189, 248, 0.4)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(10, 10, 175, 24, 4);
    ctx.fill();
    ctx.stroke();

    ctx.font = '10px var(--font-mono)';
    ctx.fillStyle = '#38bdf8';
    ctx.fillText('PointNet++ mIoU: 78.4%', 16, 26);

    // Ego vehicle
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = '#38bdf8';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.roundRect(centerX - 6, centerY + 55, 12, 20, 3);
    ctx.fill();
    ctx.stroke();
  }, [panel2Filter]);

  // -------------------------------------------------------------
  // PANEL 3: ADAPTIVE FOVEAGRID (VARIABLE RESOLUTION)
  // -------------------------------------------------------------
  useEffect(() => {
    const canvas = canvas3Ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const width = (canvas.width = canvas.parentElement?.clientWidth || 400);
    const height = (canvas.height = canvas.parentElement?.clientHeight || 280);

    ctx.fillStyle = '#060911';
    ctx.fillRect(0, 0, width, height);

    const centerX = width / 2;
    const centerY = height / 2;
    const maxRadius = Math.min(width, height) * 0.45;

    // Concentric Zones Definition
    // Zone 1: 0 - 5m   -> 5cm
    // Zone 2: 5 - 20m  -> 10cm
    // Zone 3: 20 - 50m -> 25cm
    // Zone 4: > 50m    -> 50cm
    const rings = [
      { r: maxRadius * 0.22, color: '#06b6d4', label: '5 cm', dist: '0-5m', dash: [] },
      { r: maxRadius * 0.48, color: '#10b981', label: '10 cm', dist: '5-20m', dash: [3, 3] },
      { r: maxRadius * 0.76, color: '#f59e0b', label: '25 cm', dist: '20-50m', dash: [4, 4] },
      { r: maxRadius, color: '#a855f7', label: '50 cm', dist: '>50m', dash: [6, 6] },
    ];

    // Radial Spokes
    ctx.strokeStyle = 'rgba(30, 41, 59, 0.45)';
    ctx.lineWidth = 1;
    for (let a = 0; a < Math.PI * 2; a += Math.PI / 6) {
      ctx.beginPath();
      ctx.moveTo(centerX, centerY);
      ctx.lineTo(centerX + Math.cos(a) * maxRadius, centerY + Math.sin(a) * maxRadius);
      ctx.stroke();
    }

    // Draw rings & fills
    for (let i = rings.length - 1; i >= 0; i--) {
      const ring = rings[i];
      ctx.fillStyle = `${ring.color}0a`;
      ctx.beginPath();
      ctx.arc(centerX, centerY, ring.r, 0, Math.PI * 2);
      ctx.fill();

      ctx.strokeStyle = ring.color;
      ctx.lineWidth = 1.5;
      ctx.setLineDash(ring.dash);
      ctx.beginPath();
      ctx.arc(centerX, centerY, ring.r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);

      // Ring text
      ctx.fillStyle = ring.color;
      ctx.font = '10px var(--font-mono)';
      ctx.fillText(`${ring.label} (${ring.dist})`, centerX + 6, centerY - ring.r + 14);
    }

    // Grid cell simulation in inner zone (dense) vs outer zone (coarse)
    ctx.strokeStyle = 'rgba(6, 182, 212, 0.35)';
    ctx.lineWidth = 0.5;
    const innerR = rings[0].r;
    for (let x = -innerR; x <= innerR; x += 6) {
      for (let y = -innerR; y <= innerR; y += 6) {
        if (x * x + y * y <= innerR * innerR) {
          ctx.strokeRect(centerX + x, centerY + y, 5, 5);
        }
      }
    }

    // Sweeping Radar Line
    const sweep = (animTick * 0.04) % (Math.PI * 2);
    ctx.save();
    ctx.translate(centerX, centerY);
    const sweepGrad = ctx.createRadialGradient(0, 0, 0, 0, 0, maxRadius);
    sweepGrad.addColorStop(0, 'rgba(6, 182, 212, 0.6)');
    sweepGrad.addColorStop(1, 'rgba(6, 182, 212, 0.0)');
    ctx.fillStyle = sweepGrad;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.arc(0, 0, maxRadius, sweep - 0.35, sweep);
    ctx.closePath();
    ctx.fill();

    ctx.strokeStyle = '#38bdf8';
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(Math.cos(sweep) * maxRadius, Math.sin(sweep) * maxRadius);
    ctx.stroke();
    ctx.restore();

    // Center Ego Vehicle Icon
    ctx.fillStyle = '#f8fafc';
    ctx.strokeStyle = '#06b6d4';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.roundRect(centerX - 5, centerY - 8, 10, 16, 2);
    ctx.fill();
    ctx.stroke();
  }, [animTick]);

  // -------------------------------------------------------------
  // PANEL 4: 2.5D ELEVATION & SEMANTIC MAP
  // -------------------------------------------------------------
  useEffect(() => {
    const canvas = canvas4Ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const width = (canvas.width = canvas.parentElement?.clientWidth || 700);
    const height = (canvas.height = canvas.parentElement?.clientHeight || 340);

    ctx.fillStyle = '#070b13';
    ctx.fillRect(0, 0, width, height);

    const { minX, maxX, minY, maxY, minZ, maxZ } = mapBounds;
    const spanX = maxX - minX || 1;
    const spanY = maxY - minY || 1;

    // View Transforms
    if (panel4View === 'top' || panel4View === 'elevation') {
      const margin = 28;
      const availableW = width - margin * 2;
      const availableH = height - margin * 2;
      const cellScale = Math.min(availableW / spanX, availableH / spanY);
      const offsetX = margin + (availableW - spanX * cellScale) / 2;
      const offsetY = margin + (availableH - spanY * cellScale) / 2;

      // Draw background grid lines
      ctx.strokeStyle = 'rgba(30, 41, 59, 0.4)';
      ctx.lineWidth = 0.5;
      for (let x = 0; x <= spanX; x += 10) {
        ctx.beginPath();
        ctx.moveTo(offsetX + x * cellScale, offsetY);
        ctx.lineTo(offsetX + x * cellScale, offsetY + spanY * cellScale);
        ctx.stroke();
      }
      for (let y = 0; y <= spanY; y += 10) {
        ctx.beginPath();
        ctx.moveTo(offsetX, offsetY + y * cellScale);
        ctx.lineTo(offsetX + spanX * cellScale, offsetY + y * cellScale);
        ctx.stroke();
      }

      // Draw 1000 Map Cells
      for (const cell of cells) {
        const x = offsetX + (cell.gx - minX) * cellScale;
        const y = offsetY + (cell.gy - minY) * cellScale;
        const cellPixelSize = Math.max(3, cell.res * cellScale * 14);

        if (panel4Mode === 'elevation') {
          ctx.fillStyle = getElevationColor(cell.z_mean, minZ, maxZ);
        } else {
          // Semantic class color
          ctx.fillStyle = cell.dominant_class === 2 ? '#eab308' : '#38bdf8';
        }

        ctx.fillRect(x, y, cellPixelSize, cellPixelSize);

        // Highlight hovered cell
        if (hoveredCell && hoveredCell.gx === cell.gx && hoveredCell.gy === cell.gy) {
          ctx.strokeStyle = '#ffffff';
          ctx.lineWidth = 2;
          ctx.strokeRect(x - 2, y - 2, cellPixelSize + 4, cellPixelSize + 4);
        }
      }
    } else {
      // 3D Isometric Elevation View
      const isoCenterX = width / 2;
      const isoCenterY = height / 2 + 50;
      const isoScale = Math.min(width, height) / 80;

      // Sort cells back to front for proper occlusion in 3D
      const sortedCells = [...cells].sort((a, b) => (a.gx + a.gy) - (b.gx + b.gy));

      for (const cell of sortedCells) {
        const isoX = (cell.gx - minX - (cell.gy - minY)) * isoScale * 1.4;
        const isoY = (cell.gx - minX + (cell.gy - minY)) * isoScale * 0.7;
        const colHeight = ((cell.z_mean - minZ) / (maxZ - minZ || 1)) * 45 + 5;

        const screenX = isoCenterX + isoX;
        const screenY = isoCenterY + isoY - colHeight;
        const size = Math.max(4, isoScale * 1.5);

        // Top face
        ctx.fillStyle = getElevationColor(cell.z_mean, minZ, maxZ);
        ctx.beginPath();
        ctx.moveTo(screenX, screenY);
        ctx.lineTo(screenX + size, screenY - size * 0.4);
        ctx.lineTo(screenX, screenY - size * 0.8);
        ctx.lineTo(screenX - size, screenY - size * 0.4);
        ctx.closePath();
        ctx.fill();

        // Front left face
        ctx.fillStyle = 'rgba(2, 6, 23, 0.7)';
        ctx.beginPath();
        ctx.moveTo(screenX - size, screenY - size * 0.4);
        ctx.lineTo(screenX, screenY);
        ctx.lineTo(screenX, screenY + colHeight);
        ctx.lineTo(screenX - size, screenY - size * 0.4 + colHeight);
        ctx.closePath();
        ctx.fill();

        // Front right face
        ctx.fillStyle = 'rgba(15, 23, 42, 0.9)';
        ctx.beginPath();
        ctx.moveTo(screenX, screenY);
        ctx.lineTo(screenX + size, screenY - size * 0.4);
        ctx.lineTo(screenX + size, screenY - size * 0.4 + colHeight);
        ctx.lineTo(screenX, screenY + colHeight);
        ctx.closePath();
        ctx.fill();
      }
    }
  }, [cells, mapBounds, panel4View, panel4Mode, hoveredCell]);

  // Handle cell hover in 2D top view
  const handleMapMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (panel4View === '3d') {
      setHoveredCell(null);
      setTooltipPos(null);
      return;
    }
    const canvas = canvas4Ref.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    const { minX, maxX, minY, maxY } = mapBounds;
    const spanX = maxX - minX || 1;
    const spanY = maxY - minY || 1;
    const margin = 28;
    const availableW = canvas.width - margin * 2;
    const availableH = canvas.height - margin * 2;
    const cellScale = Math.min(availableW / spanX, availableH / spanY);
    const offsetX = margin + (availableW - spanX * cellScale) / 2;
    const offsetY = margin + (availableH - spanY * cellScale) / 2;

    const approxGx = Math.round(minX + (mouseX - offsetX) / cellScale);
    const approxGy = Math.round(minY + (mouseY - offsetY) / cellScale);

    // Find nearest cell within tolerance
    const match = cells.find(
      (c) => Math.abs(c.gx - approxGx) <= 1 && Math.abs(c.gy - approxGy) <= 1
    );

    if (match) {
      setHoveredCell(match);
      setTooltipPos({ x: mouseX, y: mouseY });
    } else {
      setHoveredCell(null);
      setTooltipPos(null);
    }
  };

  const handleMapMouseLeave = () => {
    setHoveredCell(null);
    setTooltipPos(null);
  };

  // -------------------------------------------------------------
  // PANEL 5: REAL-TIME TELEMETRY SPARKLINE
  // -------------------------------------------------------------
  useEffect(() => {
    const canvas = sparklineRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const width = (canvas.width = canvas.parentElement?.clientWidth || 300);
    const height = (canvas.height = 48);

    ctx.clearRect(0, 0, width, height);

    // Draw FPS Line (Cyan)
    ctx.strokeStyle = '#06b6d4';
    ctx.lineWidth = 2;
    ctx.beginPath();
    telemetryHistory.forEach((pt, i) => {
      const x = (i / (telemetryHistory.length - 1)) * width;
      const y = height - ((pt.fps - 14) / 4) * (height - 10) - 5;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();

    // Draw Latency Line (Amber)
    ctx.strokeStyle = '#f59e0b';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([2, 2]);
    ctx.beginPath();
    telemetryHistory.forEach((pt, i) => {
      const x = (i / (telemetryHistory.length - 1)) * width;
      const y = height - ((pt.latency - 50) / 20) * (height - 10) - 5;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
    ctx.setLineDash([]);
  }, [telemetryHistory]);

  return (
    <div className="dashboard-container">
      {/* ----------------- Top Header ----------------- */}
      <header className="dashboard-header">
        <div className="header-left">
          <img 
            src="/agniveda_logo.jpeg" 
            alt="AgniVeda" 
            className="h-12 w-auto object-contain" 
            style={{ 
              mixBlendMode: 'screen', 
              filter: 'contrast(1.6) brightness(1.2)' 
            }} 
          />
          <div className="brand-info">
            <span className="brand-title">AgniVeda</span>
          </div>
        </div>

        <div className="header-center">
          <h1 className="project-title">Adaptive Variable Resolution 2.5D LiDAR Mapping</h1>
          <div className="project-subtitle">Perceive Smarter • Map Efficiently • Navigate Safer</div>
        </div>

        <div className="header-right">
          <div className={`status-badge ${isConnected ? 'online' : 'offline'}`}>
            <span className="status-pulse" />
            <span>{isConnected ? 'LIVE API (8000)' : 'LOCAL BUFFER'}</span>
          </div>
          <button
            type="button"
            className="btn-action"
            onClick={() => setIsStreaming(!isStreaming)}
            title="Toggle Live Stream Polling"
          >
            {isStreaming ? '⏸ Pause' : '▶ Resume'}
          </button>
        </div>
      </header>

      {/* ----------------- 5-Panel Grid matching Slide 6 ----------------- */}
      <main className="dashboard-grid">
        {/* ROW 1: 3 Panels */}
        <section className="grid-row-top">
          {/* Panel 1: Raw LiDAR Point Cloud */}
          <div className="panel-card">
            <div className="panel-header">
              <div className="panel-title-group">
                <span className="panel-title">1. Raw LiDAR Point Cloud</span>
                <span className="panel-subtitle">Real-time 3D point cloud from LiDAR sensor</span>
              </div>
              <div className="panel-controls">
                <button
                  type="button"
                  className={`btn-toggle ${panel1View === '3d' ? 'active' : ''}`}
                  onClick={() => setPanel1View('3d')}
                >
                  3D View
                </button>
                <button
                  type="button"
                  className={`btn-toggle ${panel1View === 'top' ? 'active' : ''}`}
                  onClick={() => setPanel1View('top')}
                >
                  Top View
                </button>
                <button
                  type="button"
                  className={`btn-toggle ${panel1View === 'side' ? 'active' : ''}`}
                  onClick={() => setPanel1View('side')}
                >
                  Side View
                </button>
              </div>
            </div>

            <div className="canvas-wrapper">
              <div className="overlay-stats-top">
                <span>Points: <strong className="highlight">124,612</strong></span>
                <span>• 128 Beams</span>
              </div>
              <canvas
                ref={canvas1Ref}
                className="canvas-element"
                onMouseDown={handlePanel1MouseDown}
                onMouseMove={handlePanel1MouseMove}
                onMouseUp={handlePanel1MouseUp}
                onMouseLeave={handlePanel1MouseUp}
              />
            </div>

            <div className="intensity-bar-container">
              <span>0.0 Low</span>
              <div className="intensity-gradient" />
              <span>1.0 High Intensity</span>
            </div>
          </div>

          {/* Panel 2: AI Perception (Semantic Segmentation) */}
          <div className="panel-card">
            <div className="panel-header">
              <div className="panel-title-group">
                <span className="panel-title">2. AI Perception (Semantic Segmentation)</span>
                <span className="panel-subtitle">Detected objects and semantic classes</span>
              </div>
              <div className="panel-controls">
                <button
                  type="button"
                  className={`btn-toggle ${panel2Filter === 'all' ? 'active' : ''}`}
                  onClick={() => setPanel2Filter('all')}
                >
                  All
                </button>
                <button
                  type="button"
                  className={`btn-toggle ${panel2Filter === 'vehicle' ? 'active' : ''}`}
                  onClick={() => setPanel2Filter('vehicle')}
                >
                  Vehicles
                </button>
                <button
                  type="button"
                  className={`btn-toggle ${panel2Filter === 'pedestrian' ? 'active' : ''}`}
                  onClick={() => setPanel2Filter('pedestrian')}
                >
                  Pedestrians
                </button>
              </div>
            </div>

            <div className="canvas-wrapper">
              <canvas ref={canvas2Ref} className="canvas-element" />
            </div>

            <div className="panel-legend">
              <div className="legend-item" onClick={() => setPanel2Filter(panel2Filter === 'road' ? 'all' : 'road')}>
                <span className="legend-color-dot" style={{ backgroundColor: '#38bdf8' }} />
                <span>Road</span>
              </div>
              <div className="legend-item" onClick={() => setPanel2Filter(panel2Filter === 'vehicle' ? 'all' : 'vehicle')}>
                <span className="legend-color-dot" style={{ backgroundColor: '#eab308' }} />
                <span>Vehicle</span>
              </div>
              <div className="legend-item" onClick={() => setPanel2Filter(panel2Filter === 'pedestrian' ? 'all' : 'pedestrian')}>
                <span className="legend-color-dot" style={{ backgroundColor: '#ef4444' }} />
                <span>Pedestrian</span>
              </div>
              <div className="legend-item" onClick={() => setPanel2Filter(panel2Filter === 'vegetation' ? 'all' : 'vegetation')}>
                <span className="legend-color-dot" style={{ backgroundColor: '#22c55e' }} />
                <span>Vegetation</span>
              </div>
              <div className="legend-item" onClick={() => setPanel2Filter(panel2Filter === 'building' ? 'all' : 'building')}>
                <span className="legend-color-dot" style={{ backgroundColor: '#f97316' }} />
                <span>Building</span>
              </div>
            </div>
          </div>

          {/* Panel 3: Adaptive FoveaGrid (Variable Resolution) */}
          <div className="panel-card">
            <div className="panel-header">
              <div className="panel-title-group">
                <span className="panel-title">3. Adaptive FoveaGrid (Variable Resolution)</span>
                <span className="panel-subtitle">Finer grid near, coarser grid far</span>
              </div>
              <div className="panel-controls">
                <span className="btn-toggle active">Polar Radial</span>
              </div>
            </div>

            <div className="canvas-wrapper">
              <div className="overlay-stats-top">
                <span>Rings: <strong className="highlight">4 Zones</strong></span>
                <span>• 85% Cell Reduction</span>
              </div>
              <canvas ref={canvas3Ref} className="canvas-element" />
            </div>

            <div className="foveagrid-legend-bar">
              <div className="fovea-zone-pill zone-5cm">
                <span className="zone-res">5 cm</span>
                <span className="zone-range">Near (0-5m)</span>
              </div>
              <div className="fovea-zone-pill zone-10cm">
                <span className="zone-res">10 cm</span>
                <span className="zone-range">Mid-Near (5-20m)</span>
              </div>
              <div className="fovea-zone-pill zone-25cm">
                <span className="zone-res">25 cm</span>
                <span className="zone-range">Mid (20-50m)</span>
              </div>
              <div className="fovea-zone-pill zone-50cm">
                <span className="zone-res">50 cm</span>
                <span className="zone-range">Far (&gt;50m)</span>
              </div>
            </div>
          </div>
        </section>

        {/* ROW 2: 2 Panels (Map Data & Telemetry) */}
        <section className="grid-row-bottom">
          {/* Panel 4: 2.5D Elevation & Semantic Map (Top View) */}
          <div className="panel-card">
            <div className="panel-header">
              <div className="panel-title-group">
                <span className="panel-title">4. 2.5D Elevation & Semantic Map (Top View)</span>
                <span className="panel-subtitle">
                  Height-aware occupancy map with semantic information • Showing {cells.length} cells
                </span>
              </div>
              <div className="panel-controls">
                <button
                  type="button"
                  className={`btn-toggle ${panel4View === 'top' ? 'active' : ''}`}
                  onClick={() => setPanel4View('top')}
                >
                  Top View
                </button>
                <button
                  type="button"
                  className={`btn-toggle ${panel4View === '3d' ? 'active' : ''}`}
                  onClick={() => setPanel4View('3d')}
                >
                  3D View
                </button>
                <button
                  type="button"
                  className={`btn-toggle ${panel4Mode === 'elevation' ? 'active' : ''}`}
                  onClick={() => setPanel4Mode(panel4Mode === 'elevation' ? 'semantic' : 'elevation')}
                >
                  {panel4Mode === 'elevation' ? 'Elevation' : 'Semantic'}
                </button>
              </div>
            </div>

            <div className="map-canvas-container canvas-wrapper">
              <canvas
                ref={canvas4Ref}
                className="canvas-element"
                onMouseMove={handleMapMouseMove}
                onMouseLeave={handleMapMouseLeave}
              />

              {/* Floating Tooltip Inspector */}
              {hoveredCell && tooltipPos && (
                <div
                  className="cell-tooltip"
                  style={{ left: `${tooltipPos.x}px`, top: `${tooltipPos.y}px` }}
                >
                  <div className="cell-tooltip-title">
                    Cell ({hoveredCell.gx}, {hoveredCell.gy})
                  </div>
                  <div className="cell-tooltip-row">
                    <span>Elevation (z_mean):</span>
                    <span>{hoveredCell.z_mean.toFixed(3)} m</span>
                  </div>
                  <div className="cell-tooltip-row">
                    <span>Height Span (Δz):</span>
                    <span>{hoveredCell.elevation_span.toFixed(3)} m</span>
                  </div>
                  <div className="cell-tooltip-row">
                    <span>Resolution:</span>
                    <span>{hoveredCell.res} m</span>
                  </div>
                  <div className="cell-tooltip-row">
                    <span>Point Count:</span>
                    <span>{hoveredCell.point_count} pts</span>
                  </div>
                  <div className="cell-tooltip-row">
                    <span>Class:</span>
                    <span>{hoveredCell.class_name} (ID: {hoveredCell.dominant_class})</span>
                  </div>
                  <div className="cell-tooltip-row">
                    <span>Confidence:</span>
                    <span>{(hoveredCell.mean_confidence * 100).toFixed(1)}%</span>
                  </div>
                </div>
              )}
            </div>

            <div className="map-footer-stats">
              <div className="elevation-scale-bar">
                <span>0.7m Ground</span>
                <div className="elevation-gradient" />
                <span>1.6m Obstacle</span>
              </div>
              <div>
                Grid Span: <strong>{mapBounds.spanX ?? 50} × {mapBounds.spanY ?? 42} cells</strong> • Source:{' '}
                <code>/api/map-data</code>
              </div>
            </div>
          </div>

          {/* Panel 5: Real-Time Performance */}
          <div className="panel-card">
            <div className="panel-header">
              <div className="panel-title-group">
                <span className="panel-title">5. Real-Time Performance</span>
                <span className="panel-subtitle">System metrics and efficiency</span>
              </div>
              <div className="panel-controls">
                <span className="btn-toggle active">SIH Metrics</span>
              </div>
            </div>

            <div className="performance-content">
              {/* 4 Metrics Cards */}
              <div className="metrics-cards-grid">
                {/* FPS */}
                <div className="metric-card">
                  <div className="metric-card-header">
                    <span className="metric-label">FPS</span>
                    <span className="metric-tag green">Real-Time</span>
                  </div>
                  <div className="metric-value-box">
                    <span className="metric-value">{telemetry.fps.toFixed(1)}</span>
                  </div>
                  <span className="metric-subtext">Target: &gt;15 FPS</span>
                </div>

                {/* Latency */}
                <div className="metric-card">
                  <div className="metric-card-header">
                    <span className="metric-label">Latency</span>
                    <span className="metric-tag green">Optimal</span>
                  </div>
                  <div className="metric-value-box">
                    <span className="metric-value">{telemetry.latency_ms.toFixed(1)}</span>
                    <span className="metric-unit">ms</span>
                  </div>
                  <span className="metric-subtext">Target: &lt;70 ms</span>
                </div>

                {/* Memory Usage */}
                <div className="metric-card">
                  <div className="metric-card-header">
                    <span className="metric-label">Memory</span>
                    <span className="metric-tag green">Ultra-low</span>
                  </div>
                  <div className="metric-value-box">
                    <span className="metric-value">{telemetry.memory_gb.toFixed(1)}</span>
                    <span className="metric-unit">GB</span>
                  </div>
                  <span className="metric-subtext">Budget: 2.0 GB Edge</span>
                </div>

                {/* Total Cells */}
                <div className="metric-card">
                  <div className="metric-card-header">
                    <span className="metric-label">Total Cells</span>
                    <span className="metric-tag cyan">FoveaGrid</span>
                  </div>
                  <div className="metric-value-box">
                    <span className="metric-value">{telemetry.total_cells}</span>
                  </div>
                  <span className="metric-subtext">Input Points: 124K</span>
                </div>
              </div>

              {/* Grid Cell Count (Adaptive) vs Uniform Grid */}
              <div className="efficiency-section">
                <div className="efficiency-header">
                  <span className="efficiency-title">Grid Cell Count (Adaptive vs Uniform)</span>
                  <span className="efficiency-badge">85.0% Reduced</span>
                </div>
                <div className="comparison-bars-container">
                  <div className="bar-row">
                    <div className="bar-labels">
                      <span>Adaptive FoveaGrid</span>
                      <strong>{telemetry.total_cells} (15%)</strong>
                    </div>
                    <div className="bar-track">
                      <div className="bar-fill-adaptive" />
                    </div>
                  </div>
                  <div className="bar-row">
                    <div className="bar-labels">
                      <span>Traditional Uniform (5cm)</span>
                      <span>3.20 M (100%)</span>
                    </div>
                    <div className="bar-track">
                      <div className="bar-fill-uniform" />
                    </div>
                  </div>
                </div>
              </div>

              {/* Live Telemetry Trend Sparkline */}
              <div className="telemetry-sparkline-box">
                <div className="sparkline-header">
                  <span>Live Stream Telemetry Trend</span>
                  <div className="legend-dots">
                    <span style={{ color: '#06b6d4' }}>● FPS</span>
                    <span style={{ color: '#f59e0b' }}>● Latency (ms)</span>
                  </div>
                </div>
                <canvas ref={sparklineRef} className="sparkline-canvas" />
              </div>
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}
