import { Response } from 'express';
import { supabase } from '../services/supabase';
import { AuthRequest } from '../types';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { saveGeneration } from './generation.controller';
import {
  CreateProjectInput,
  SaveRoomsInput,
  SaveDimensionsInput,
  UpdateProjectInput,
  GenerateRenderInput,
  Room,
} from '../schemas/project.schema';

// ─── Multer file type ─────────────────────────────────────────────────────────

interface UploadedFile {
  fieldname: string;
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function computeTotalArea(rooms: Room[]): number {
  return parseFloat(
    rooms.reduce((sum, r) => {
      if (r.length && r.width) return sum + r.length * r.width;
      return sum;
    }, 0).toFixed(1)
  );
}

async function verifyOwnership(projectId: string, userId: string) {
  const { data } = await supabase
    .from('projects')
    .select('id, room_data, floor_plan_url, status')
    .eq('id', projectId)
    .eq('user_id', userId)
    .single();
  return data;
}

// ─── Gemini Vision — Real room detection (two-pass) ──────────────────────────

interface RawRoom {
  name: string;
  confidence: number;
  color: string;
  box_2d?: [number, number, number, number];
  dimensions?: { length: number; width: number; unit: 'ft' | 'm' } | null;
}

function extractJson(text: string): string {
  // Strip markdown fences first
  let cleaned = text
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  // Find the first '[' and last ']' to extract just the array,
  // ignoring any trailing text or comments Gemini appended
  const start = cleaned.indexOf('[');
  const end   = cleaned.lastIndexOf(']');

  if (start === -1 || end === -1 || end < start) {
    throw new Error(`No JSON array found in Gemini response. Raw: ${cleaned.slice(0, 200)}`);
  }

  return cleaned.slice(start, end + 1);
}

function extractJsonObject(text: string): string {
  let cleaned = text
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  const start = cleaned.indexOf('{');
  const end   = cleaned.lastIndexOf('}');

  if (start === -1 || end === -1 || end < start) {
    throw new Error(`No JSON object found in Gemini response. Raw: ${cleaned.slice(0, 200)}`);
  }

  return cleaned.slice(start, end + 1);
}

// Pass 1 — detect all rooms with names, colors, dimensions, and a first-guess box
async function detectRoomsPass1(
  model: ReturnType<GoogleGenerativeAI['getGenerativeModel']>,
  base64Image: string,
  mimeType: string
): Promise<RawRoom[]> {
  const prompt = `
    You are an expert architect analyzing a floor plan image or drawing.
    Detect all distinct rooms/spaces visible in this floor plan.

    Return ONLY a valid JSON array. No markdown, no explanation, no code blocks.

    Each room object must have exactly these fields:

    - "name": string — a clear, human-readable room name.
      If there are multiple rooms of the same type (e.g. two bedrooms),
      number them distinctly: "Bedroom 1", "Bedroom 2", "Bathroom 1", "Bathroom 2", etc.
      Use "Master Bedroom" only for the largest/primary bedroom (max once).
      Common types: Living Room, Kitchen, Bedroom, Master Bedroom, Bathroom,
      Hallway, Storage, Dining Room, Study/Office, Balcony, Closet, Stairs, Garage, Entry, Porch, Patio.

    - "confidence": number between 0 and 100 (how confident you are in this detection)

    - "color": string (a soft, distinct hex color for this room type — use pastel tones)

    - "box_2d": [ymin, xmin, ymax, xmax] — your BEST FIRST ESTIMATE of this room's full
      floor area bounding box, normalized to a 0-1000 scale where [0,0] is the top-left
      corner of the entire image and [1000,1000] is the bottom-right corner.
      The box should extend to the room's actual wall lines, not just its text label.
      This will be refined in a second pass, so a reasonable estimate is fine here.

    - "dimensions": object or null — if the floor plan image has printed text showing this
      room's measurements (e.g. "14'-7\\" X 16'", "20'8\\" X 17'", "12' X 24'", or metric
      equivalents like "4.5m x 3.5m"), extract them here as:
      { "length": number, "width": number, "unit": "ft" | "m" }
      Convert feet-inches notation (e.g. 14'-7") to decimal feet (14.58).
      If no dimension text is visible for a room, set "dimensions" to null — do not guess or invent numbers.

    Color guide (use these as reference, vary slightly for repeated room types):
    - Living Room: #c3f4f0
    - Kitchen: #b9eac5
    - Bedroom: #87ddd7
    - Master Bedroom: #6dd0c4
    - Bathroom: #f7dfad
    - Hallway/Corridor: #d5dbda
    - Storage/Utility/Closet: #ffc9c0
    - Dining Room: #c7d2fe
    - Study/Office: #fde68a
    - Balcony/Terrace/Porch/Patio: #a7f3d0
    - Stairs: #e0c3fc
    - Other: #e5e7eb

    IMPORTANT: Every room name in the output array must be unique.
    Never output the same name twice — always number duplicates (Bedroom 1, Bedroom 2...).

    Example output format:
    [{"name":"Living Room","confidence":95,"color":"#c3f4f0","box_2d":[120,80,420,360],"dimensions":{"length":20.67,"width":17,"unit":"ft"}},{"name":"Porch","confidence":90,"color":"#a7f3d0","box_2d":[700,50,950,500],"dimensions":{"length":24,"width":12,"unit":"ft"}}]

    Only return the JSON array. Nothing else at all.
  `;

  const result = await model.generateContent([
    { text: prompt },
    { inlineData: { data: base64Image, mimeType } },
  ]);

  const rawText = result.response.text().trim();
  try {
    return JSON.parse(extractJson(rawText));
  } catch (parseErr) {
    console.error('Pass 1 JSON parse failed. Raw Gemini response:', rawText.slice(0, 500));
    throw parseErr;
  }
}

// Pass 2 — re-examine the same full image, but ask Gemini to tighten ONE room's box
// against the real wall boundaries, now that it already knows the floor plan layout.
async function refineRoomBox(
  model: ReturnType<GoogleGenerativeAI['getGenerativeModel']>,
  base64Image: string,
  mimeType: string,
  room: RawRoom
): Promise<[number, number, number, number] | null> {
  if (!room.box_2d) return null;

  const prompt = `
    Here is a floor plan image. A room called "${room.name}" was previously detected
    with this approximate bounding box (0-1000 scale, [ymin, xmin, ymax, xmax]):
    ${JSON.stringify(room.box_2d)}

    Look very closely at the "${room.name}" area of this floor plan and give a CORRECTED,
    tightly-fitted bounding box that extends exactly to that room's wall lines on all sides —
    covering its entire floor footprint, not just the area near its text label.

    Return ONLY a JSON object with this exact shape, nothing else:
    {"box_2d":[ymin,xmin,ymax,xmax]}
  `;

  try {
    const result = await model.generateContent([
      { text: prompt },
      { inlineData: { data: base64Image, mimeType } },
    ]);
    const parsed = JSON.parse(extractJsonObject(result.response.text().trim()));
    if (Array.isArray(parsed.box_2d) && parsed.box_2d.length === 4) {
      return parsed.box_2d as [number, number, number, number];
    }
    return null;
  } catch {
    // If refinement fails for this room, fall back to the pass-1 box silently
    return null;
  }
}

// Pass 3 — detect all doors and windows across the entire floor plan
// Returns openings with position on the 0-1000 scale and which wall they sit on.
interface RawOpening {
  type: 'door' | 'window';
  wall: 'horizontal' | 'vertical'; // orientation of the wall the opening is in
  x: number;   // center x in 0-1000 scale
  y: number;   // center y in 0-1000 scale
  width: number; // opening width in 0-1000 scale units
}

async function detectOpenings(
  model: ReturnType<GoogleGenerativeAI['getGenerativeModel']>,
  base64Image: string,
  mimeType: string
): Promise<RawOpening[]> {
  const prompt = `
    You are an expert architect analyzing a floor plan image.
    Detect ALL doors and windows visible in this floor plan.

    Return ONLY a valid JSON array. No markdown, no explanation.

    Each object must have exactly these fields:
    - "type": "door" or "window"
    - "wall": "horizontal" (wall runs left-right) or "vertical" (wall runs top-bottom)
    - "x": number — center x position, normalized 0-1000 (0=left edge, 1000=right edge)
    - "y": number — center y position, normalized 0-1000 (0=top edge, 1000=bottom edge)
    - "width": number — opening width in the same 0-1000 scale (typical door: 30-60, window: 40-80)

    Tips for detecting doors:
    - Look for arc symbols (quarter-circle swing arcs) on walls
    - Look for gaps in walls with a thin line across
    - Typical door symbols: a line with an arc attached

    Tips for detecting windows:
    - Look for parallel lines crossing a wall (usually 3 lines close together)
    - Windows sit in exterior walls

    Example:
    [{"type":"door","wall":"horizontal","x":250,"y":430,"width":40},{"type":"window","wall":"vertical","x":800,"y":200,"width":60}]

    Return empty array [] if none found. Only return the JSON array.
  `;

  try {
    const result = await model.generateContent([
      { text: prompt },
      { inlineData: { data: base64Image, mimeType } },
    ]);
    const rawText = result.response.text().trim();
    console.log(`Pass 3 openings raw:`, rawText.slice(0, 300));
    const parsed = JSON.parse(extractJson(rawText));
    if (Array.isArray(parsed)) {
      console.log(`Pass 3: detected ${parsed.length} openings`);
      return parsed as RawOpening[];
    }
    return [];
  } catch (err) {
    console.error('Pass 3 openings failed:', err);
    return [];
  }
}

// ─── Roboflow floor plan detection ────────────────────────────────────────────
// Uses CubiCasa5k-2 model to detect walls, doors, windows with precise coordinates

interface RoboflowPrediction {
  x: number;      // center x in pixels
  y: number;      // center y in pixels
  width: number;  // bounding box width in pixels
  height: number; // bounding box height in pixels
  class: 'wall' | 'door' | 'window';
  confidence: number;
}

interface RoboflowResult {
  predictions: RoboflowPrediction[];
  image: { width: number; height: number };
}

async function detectWithRoboflow(imageUrl: string): Promise<{
  walls: RoboflowPrediction[];
  doors: RoboflowPrediction[];
  windows: RoboflowPrediction[];
  imageWidth: number;
  imageHeight: number;
}> {
  const apiKey = process.env.ROBOFLOW_API_KEY;
  if (!apiKey) throw new Error('ROBOFLOW_API_KEY is not set');

  // Fetch image and convert to base64
  const imgRes = await fetch(imageUrl);
  if (!imgRes.ok) throw new Error(`Failed to fetch image: ${imgRes.statusText}`);
  const imgBuffer = await imgRes.arrayBuffer();
  const base64 = Buffer.from(imgBuffer).toString('base64');

  // Call Roboflow serverless API
  const response = await fetch(
    `https://serverless.roboflow.com/cubicasa5k-2-qpmsa/6?api_key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: base64,
    }
  );

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Roboflow API error (${response.status}): ${err}`);
  }

  const result = await response.json() as RoboflowResult;
  const predictions = result.predictions || [];

  console.log(`Roboflow detected: ${predictions.length} elements on ${result.image.width}x${result.image.height}px image`);
  predictions.forEach(p => console.log(`  ${p.class}: x=${p.x.toFixed(0)}, y=${p.y.toFixed(0)}, w=${p.width.toFixed(0)}, h=${p.height.toFixed(0)}, conf=${p.confidence.toFixed(2)}`));

  return {
    walls:       predictions.filter(p => p.class === 'wall'),
    doors:       predictions.filter(p => p.class === 'door'),
    windows:     predictions.filter(p => p.class === 'window'),
    imageWidth:  result.image.width,
    imageHeight: result.image.height,
  };
}

// ─── Gemini room naming only ───────────────────────────────────────────────────
// Given wall bounding boxes from Roboflow, ask Gemini to identify room types
// and assign names + colors. This is what Gemini is actually good at.
async function nameRoomsWithGemini(
  model: ReturnType<GoogleGenerativeAI['getGenerativeModel']>,
  base64Image: string,
  mimeType: string,
  walls: RoboflowPrediction[],
  imageWidth: number,
  imageHeight: number
): Promise<RawRoom[]> {
  // Compute room regions as gaps between walls (approximate room centers)
  // We give Gemini the image and ask it only to name visible rooms, not position them
  const prompt = `
    You are an expert architect analyzing a floor plan image.
    Detect all distinct rooms/spaces visible in this floor plan.

    Return ONLY a valid JSON array. No markdown, no explanation, no code blocks.

    Each room object must have exactly these fields:
    - "name": string — clear human-readable room name (e.g. "Living Room", "Kitchen", "Master Bedroom")
      Number duplicates: "Bedroom 1", "Bedroom 2", etc.
    - "confidence": number 0-100
    - "color": string — soft distinct hex pastel color for this room type
    - "box_2d": [ymin, xmin, ymax, xmax] — approximate room bounding box, 0-1000 scale
    - "dimensions": { "length": number, "width": number, "unit": "ft"|"m" } or null

    Color guide:
    - Living Room: #c3f4f0, Kitchen: #b9eac5, Bedroom: #87ddd7, Master Bedroom: #6dd0c4
    - Bathroom: #f7dfad, Hallway: #d5dbda, Storage/Closet: #ffc9c0, Dining Room: #c7d2fe
    - Study/Office: #fde68a, Balcony/Porch/Patio: #a7f3d0, Stairs: #e0c3fc, Other: #e5e7eb

    Every room name must be unique. Only return the JSON array.
  `;

  const rawText = (await model.generateContent([
    { text: prompt },
    { inlineData: { data: base64Image, mimeType } },
  ])).response.text().trim();

  try {
    return JSON.parse(extractJson(rawText));
  } catch {
    console.error('Room naming parse failed:', rawText.slice(0, 300));
    return [];
  }
}

// ─── Fallback room generation from Roboflow wall clusters ─────────────────────
// When Gemini is unavailable, cluster wall segments into approximate room regions
// using a simple grid partition. Gives users generic room names so they can
// proceed through the modal and rename manually.
function generateFallbackRooms(
  walls: RoboflowPrediction[],
  doors: RoboflowPrediction[],
  imgW: number,
  imgH: number
): RawRoom[] {
  if (walls.length === 0) return [];

  // Find wall extents
  const allX = walls.flatMap(w => [w.x - w.width/2, w.x + w.width/2]);
  const allY = walls.flatMap(w => [w.y - w.height/2, w.y + w.height/2]);
  const minX = Math.min(...allX); const maxX = Math.max(...allX);
  const minY = Math.min(...allY); const maxY = Math.max(...allY);

  // Estimate number of rooms from door count (each door ≈ one room boundary)
  const roomCount = Math.max(2, Math.min(doors.length + 1, 8));
  const cols = roomCount <= 4 ? 2 : 3;
  const rows = Math.ceil(roomCount / cols);

  const ROOM_COLORS = [
    '#c3f4f0','#b9eac5','#87ddd7','#6dd0c4',
    '#f7dfad','#d5dbda','#ffc9c0','#c7d2fe',
    '#fde68a','#a7f3d0','#e0c3fc','#e5e7eb',
  ];

  const ROOM_NAMES = [
    'Living Room','Bedroom','Kitchen','Bathroom',
    'Dining Room','Master Bedroom','Hallway','Study',
    'Closet','Laundry','Porch','Storage',
  ];

  const rooms: RawRoom[] = [];
  let idx = 0;

  for (let r = 0; r < rows && idx < roomCount; r++) {
    for (let c = 0; c < cols && idx < roomCount; c++) {
      const cellW = (maxX - minX) / cols;
      const cellH = (maxY - minY) / rows;
      const x1 = minX + c * cellW;
      const y1 = minY + r * cellH;
      const x2 = x1 + cellW;
      const y2 = y1 + cellH;

      // Convert to 0-1000 scale
      const toScale = (v: number, max: number) => Math.round((v / max) * 1000);
      rooms.push({
        name:       ROOM_NAMES[idx] || `Room ${idx + 1}`,
        confidence: 60,
        color:      ROOM_COLORS[idx % ROOM_COLORS.length],
        box_2d:     [toScale(y1, imgH), toScale(x1, imgW), toScale(y2, imgH), toScale(x2, imgW)],
        dimensions: null,
      });
      idx++;
    }
  }

  console.log(`Fallback: generated ${rooms.length} placeholder rooms from wall data`);
  return rooms;
}

async function detectRooms(floorPlanUrl: string, projectId: string): Promise<{
  rooms: Room[];
  walls: Array<{ x1: number; y1: number; x2: number; y2: number; thickness: number }>;
  openings: RawOpening[];
  imgW: number;
  imgH: number;
}> {
  const geminiKey = process.env.GEMINI_API_KEY;
  if (!geminiKey) throw new Error('GEMINI_API_KEY is not set');

  const genAI = new GoogleGenerativeAI(geminiKey);
  // gemini-2.5-flash has the best vision capability for floor plan analysis
  const model = genAI.getGenerativeModel({
    model: 'gemini-2.5-flash',
    generationConfig: { responseMimeType: 'application/json' },
  });

  // Fetch image once — shared across Roboflow and Gemini
  const imageResponse = await fetch(floorPlanUrl);
  if (!imageResponse.ok) throw new Error(`Failed to fetch floor plan image: ${imageResponse.statusText}`);
  const imageBuffer = await imageResponse.arrayBuffer();
  const base64Image = Buffer.from(imageBuffer).toString('base64');
  const mimeType = (imageResponse.headers.get('content-type') || 'image/png').split(';')[0];

  // ── Step 1: Roboflow — precise wall/door/window detection ──
  let rfWalls: RoboflowPrediction[] = [];
  let rfDoors: RoboflowPrediction[] = [];
  let rfWindows: RoboflowPrediction[] = [];
  let imgW = 1000;
  let imgH = 1000;

  try {
    const rf = await detectWithRoboflow(floorPlanUrl);
    rfWalls   = rf.walls;
    rfDoors   = rf.doors;
    rfWindows = rf.windows;
    imgW      = rf.imageWidth;
    imgH      = rf.imageHeight;
    console.log(`Roboflow: ${rfWalls.length} walls, ${rfDoors.length} doors, ${rfWindows.length} windows`);
  } catch (rfErr) {
    console.error('Roboflow detection failed, falling back to Gemini only:', rfErr);
  }

  // ── Step 2: Gemini — room naming with exponential backoff ──
  let parsed: RawRoom[] = [];
  const delays = [3000, 6000, 10000]; // retry after 3s, 6s, 10s
  let geminiSucceeded = false;

  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      parsed = await nameRoomsWithGemini(model, base64Image, mimeType, rfWalls, imgW, imgH);
      geminiSucceeded = true;
      if (attempt > 0) console.log(`Gemini succeeded on attempt ${attempt + 1}`);
      break;
    } catch (err: any) {
      const is503 = err?.status === 503 || err?.message?.includes('503') || err?.message?.includes('Service Unavailable');
      if (is503 && attempt < delays.length) {
        console.warn(`Gemini 503 on attempt ${attempt + 1}, retrying in ${delays[attempt]}ms…`);
        await new Promise(r => setTimeout(r, delays[attempt]));
      } else {
        console.error(`Gemini room naming failed after ${attempt + 1} attempts:`, err?.message || err);
        // Generate placeholder rooms from Roboflow data so user can still proceed
        parsed = generateFallbackRooms(rfWalls, rfDoors, imgW, imgH);
        break;
      }
    }
  }

  // ── Step 3: SAM-2 — get exact room boundary masks ──
  // SAM-2's automatic mode takes ONE call per image and returns all detected
  // segments. We match each returned mask to the closest Gemini room center.
  interface RoomPolygon {
    roomIndex: number;
    polygon: [number, number][];
    bbox: { top: number; left: number; width: number; height: number };
  }

  const roomPolygons: RoomPolygon[] = [];

  const replicateToken = process.env.REPLICATE_API_TOKEN;
  if (replicateToken && parsed.length > 0) {
    try {
      const response = await fetch('https://api.replicate.com/v1/predictions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${replicateToken}`,
          'Content-Type': 'application/json',
          'Prefer': 'wait',
        },
        body: JSON.stringify({
          version: 'fe97b453a6455861e3bac769b441ca1f1086110da7466dbb65cf1eecfd60dc83',
          input: {
            image: floorPlanUrl,
            use_m2m: true,
            points_per_side: 32,
            pred_iou_thresh: 0.86,
            stability_score_thresh: 0.9,
          },
        }),
      });

      if (!response.ok) {
        const errText = await response.text();
        console.error(`SAM-2 failed: ${response.status} ${errText.slice(0, 300)}`);
      } else {
        const result = await response.json() as any;
        const maskUrls: string[] = result.output?.individual_masks || [];
        console.log(`SAM-2: received ${maskUrls.length} individual masks`);

        if (maskUrls.length > 0) {
          const sharp = require('sharp');

          // For each mask, compute its bounding box once
          const maskBboxes: Array<{ top: number; left: number; width: number; height: number; centerX: number; centerY: number } | null> =
            await Promise.all(maskUrls.map(async (maskUrl) => {
              try {
                const maskRes = await fetch(maskUrl);
                if (!maskRes.ok) return null;
                const maskBuf = Buffer.from(await maskRes.arrayBuffer());
                const { data, info } = await sharp(maskBuf).greyscale().raw().toBuffer({ resolveWithObject: true });

                let minX = info.width, maxX = 0, minY = info.height, maxY = 0;
                for (let y = 0; y < info.height; y++) {
                  for (let x = 0; x < info.width; x++) {
                    if (data[y * info.width + x] > 128) {
                      if (x < minX) minX = x;
                      if (x > maxX) maxX = x;
                      if (y < minY) minY = y;
                      if (y > maxY) maxY = y;
                    }
                  }
                }
                if (maxX <= minX || maxY <= minY) return null;
                return {
                  top:    (minY / imgH) * 100,
                  left:   (minX / imgW) * 100,
                  width:  ((maxX - minX) / imgW) * 100,
                  height: ((maxY - minY) / imgH) * 100,
                  centerX: (minX + maxX) / 2,
                  centerY: (minY + maxY) / 2,
                };
              } catch {
                return null;
              }
            }));

          // Match each Gemini room (by its center point) to the closest SAM mask
          parsed.forEach((room, idx) => {
            if (!room.box_2d) return;
            const [ymin, xmin, ymax, xmax] = room.box_2d;
            const roomCenterX = ((xmin + xmax) / 2 / 1000) * imgW;
            const roomCenterY = ((ymin + ymax) / 2 / 1000) * imgH;

            type MaskBbox = { top: number; left: number; width: number; height: number; centerX: number; centerY: number };
            let bestMatch: MaskBbox | null = null;
            let bestDist = Infinity;
            maskBboxes.forEach(bbox => {
              if (!bbox) return;
              const dist = Math.hypot(bbox.centerX - roomCenterX, bbox.centerY - roomCenterY);
              if (dist < bestDist) { bestDist = dist; bestMatch = bbox; }
            });

            // Only accept the match if it's reasonably close (within 15% of image diagonal)
            const maxDist = Math.hypot(imgW, imgH) * 0.15;
            if (bestMatch && bestDist < maxDist) {
              const m: MaskBbox = bestMatch;
              console.log(`SAM-2 matched "${room.name}" → mask bbox top=${m.top.toFixed(1)}% left=${m.left.toFixed(1)}% w=${m.width.toFixed(1)}% h=${m.height.toFixed(1)}%`);
              roomPolygons.push({
                roomIndex: idx,
                polygon: [],
                bbox: { top: m.top, left: m.left, width: m.width, height: m.height },
              });
            }
          });
        }
      }
      console.log(`SAM-2: matched ${roomPolygons.length}/${parsed.length} rooms to masks`);
    } catch (samErr) {
      console.error('SAM-2 step failed (non-fatal):', samErr);
    }
  }

  // ── Step 4: Convert Roboflow walls to normalised wall segments ──
  // Roboflow returns bounding boxes for wall segments. We convert to line segments
  // by using the longer axis as the wall direction.
  const wallSegments = rfWalls.map(w => {
    const isHorizontal = w.width > w.height;
    // Normalise to 0-100% of image dimensions
    if (isHorizontal) {
      return {
        x1: ((w.x - w.width / 2) / imgW) * 100,
        y1: (w.y / imgH) * 100,
        x2: ((w.x + w.width / 2) / imgW) * 100,
        y2: (w.y / imgH) * 100,
        thickness: Math.max(0.5, (w.height / imgH) * 100),
      };
    } else {
      return {
        x1: (w.x / imgW) * 100,
        y1: ((w.y - w.height / 2) / imgH) * 100,
        x2: (w.x / imgW) * 100,
        y2: ((w.y + w.height / 2) / imgH) * 100,
        thickness: Math.max(0.5, (w.width / imgW) * 100),
      };
    }
  });

  // ── Step 5: Convert Roboflow doors/windows to openings ──
  const openings: RawOpening[] = [
    ...rfDoors.map(d => ({
      type: 'door' as const,
      wall: (d.width > d.height ? 'horizontal' : 'vertical') as 'horizontal' | 'vertical',
      x: (d.x / imgW) * 1000,
      y: (d.y / imgH) * 1000,
      // Enforce minimum door width of 80 units (0-1000 scale) ≈ 0.8m real world
      width: Math.max(80, (Math.max(d.width, d.height) / Math.max(imgW, imgH)) * 1000),
    })),
    ...rfWindows.map(w => ({
      type: 'window' as const,
      wall: (w.width > w.height ? 'horizontal' : 'vertical') as 'horizontal' | 'vertical',
      x: (w.x / imgW) * 1000,
      y: (w.y / imgH) * 1000,
      // Enforce minimum window width of 60 units ≈ 0.6m real world
      width: Math.max(60, (Math.max(w.width, w.height) / Math.max(imgW, imgH)) * 1000),
    })),
  ];

  // ── Step 5: Build room list from Gemini naming ──
  const FT_TO_M = 0.3048;
  const nameCounts = new Map<string, number>();
  const totalCounts = new Map<string, number>();
  for (const room of parsed) {
    totalCounts.set(room.name, (totalCounts.get(room.name) || 0) + 1);
  }

  const roomList = parsed.map((room, index) => {
    let displayName = room.name;
    const total = totalCounts.get(room.name) || 1;
    if (total > 1) {
      const seen = (nameCounts.get(room.name) || 0) + 1;
      nameCounts.set(room.name, seen);
      if (!/\d+$/.test(room.name.trim())) displayName = `${room.name} ${seen}`;
    }

    // Use SAM polygon bbox if available — much more accurate than Gemini estimate
    const samResult = roomPolygons.find(p => p.roomIndex === index);
    const finalBox2d = room.box_2d;
    let box: Room['box'] = undefined;

    if (samResult) {
      box = samResult.bbox;
    } else if (Array.isArray(finalBox2d) && finalBox2d.length === 4) {
      const [ymin, xmin, ymax, xmax] = finalBox2d;
      box = {
        top:    Math.max(0, Math.min(100, ymin / 10)),
        left:   Math.max(0, Math.min(100, xmin / 10)),
        width:  Math.max(0, Math.min(100, (xmax - xmin) / 10)),
        height: Math.max(0, Math.min(100, (ymax - ymin) / 10)),
      };
    }

    let length: number | undefined;
    let width: number | undefined;
    if (room.dimensions && room.dimensions.length > 0 && room.dimensions.width > 0) {
      const factor = room.dimensions.unit === 'ft' ? FT_TO_M : 1;
      length = parseFloat((room.dimensions.length * factor).toFixed(2));
      width  = parseFloat((room.dimensions.width * factor).toFixed(2));
    }

    return {
      id: `${projectId}-r${index + 1}`,
      name: displayName,
      confidence: Math.min(100, Math.max(0, Math.round(room.confidence))),
      color: room.color || '#e5e7eb',
      box,
      length,
      width,
    };
  });

  return { rooms: roomList, walls: wallSegments, openings, imgW, imgH };
}

// ─── Step 1: Create project ───────────────────────────────────────────────────
// POST /projects

export async function createProject(req: AuthRequest, res: Response) {
  try {
    const userId = req.user!.id;
    const { name, project_type, address } = req.body as CreateProjectInput;

    // Enforce plan project limits
    const { data: profile } = await supabase
      .from('profiles')
      .select('plan')
      .eq('id', userId)
      .single();

    const plan = profile?.plan ?? 'free';
    const limits: Record<string, number> = { free: 50, starter: 10, pro: Infinity };
    const limit = limits[plan] ?? 50;

    if (limit !== Infinity) {
      const { count } = await supabase
        .from('projects')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', userId);

      if ((count ?? 0) >= limit) {
        return res.status(403).json({
          success: false,
          error: `Your ${plan} plan allows up to ${limit} projects. Upgrade to create more.`,
          code: 'PROJECT_LIMIT_REACHED',
        });
      }
    }

    const { data, error } = await supabase
      .from('projects')
      .insert({
        user_id:         userId,
        name,
        project_type,
        address:         address ?? null,
        status:          'draft',
        floor_plan_data: {},
        room_data:       {},
      })
      .select()
      .single();

    if (error) {
      return res.status(400).json({ success: false, error: error.message });
    }

    return res.status(201).json({
      success: true,
      data: { project: data },
    });

  } catch (err) {
    console.error('Create project error:', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

// ─── Step 2: Upload floor plan ────────────────────────────────────────────────
// POST /projects/:id/floor-plan  (multipart/form-data, field: floor_plan)

export async function uploadFloorPlan(req: AuthRequest, res: Response) {
  try {
    const userId    = req.user!.id;
    const projectId = String(req.params.id);

    const project = await verifyOwnership(projectId, userId);
    if (!project) {
      return res.status(404).json({ success: false, error: 'Project not found' });
    }

    const file = (req as any).file as UploadedFile | undefined;
    if (!file) {
      return res.status(400).json({ success: false, error: 'No file uploaded' });
    }

    // Validate file type
    const allowed = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
    if (!allowed.includes(file.mimetype)) {
      return res.status(400).json({
        success: false,
        error: 'Unsupported file type. Please use JPG, PNG, WebP or PDF.',
        code: 'INVALID_FILE_TYPE',
      });
    }

    // Validate size (20 MB)
    if (file.size > 20 * 1024 * 1024) {
      return res.status(400).json({
        success: false,
        error: 'File too large. Maximum size is 20 MB.',
        code: 'FILE_TOO_LARGE',
      });
    }

    // Upload to Supabase Storage
    const ext         = file.originalname.split('.').pop();
    const storagePath = `floor-plans/${userId}/${projectId}.${ext}`;

    const { error: uploadError } = await supabase.storage
      .from('nooi-projects')
      .upload(storagePath, file.buffer, {
        contentType: file.mimetype,
        upsert: true,
      });

    if (uploadError) {
      return res.status(500).json({ success: false, error: uploadError.message });
    }

    const { data: { publicUrl } } = supabase.storage
      .from('nooi-projects')
      .getPublicUrl(storagePath);

    // Save floor plan URL on project
    const { data: updated, error: updateError } = await supabase
      .from('projects')
      .update({
        floor_plan_url:  publicUrl,
        floor_plan_data: {
          storage_path:  storagePath,
          original_name: file.originalname,
          size:          file.size,
          mime:          file.mimetype,
        },
        updated_at: new Date().toISOString(),
      })
      .eq('id', projectId)
      .select()
      .single();

    if (updateError) {
      return res.status(400).json({ success: false, error: updateError.message });
    }

    // Detect rooms using Gemini Vision
    let detectedRooms: Room[] = [];
    let detectedOpenings: RawOpening[] = [];
    let detectedWalls: Array<{ x1: number; y1: number; x2: number; y2: number; thickness: number }> = [];
    let imgW = 1000; let imgH = 1000;
    try {
      const detection = await detectRooms(publicUrl, projectId);
      detectedRooms    = detection.rooms;
      detectedOpenings = detection.openings;
      detectedWalls    = detection.walls;
      imgW             = detection.imgW;
      imgH             = detection.imgH;
      console.log(`Detection complete: ${detectedRooms.length} rooms, ${detectedWalls.length} walls, ${detectedOpenings.length} openings`);
    } catch (aiErr) {
      console.error('Detection failed:', aiErr);
      detectedRooms = [];
    }

    if (detectedRooms.length > 0 || detectedWalls.length > 0) {
      await supabase
        .from('projects')
        .update({
          room_data: {
            rooms:      detectedRooms,
            walls:      detectedWalls,
            openings:   detectedOpenings,
            image_size: { width: imgW, height: imgH },
          },
          updated_at: new Date().toISOString(),
        })
        .eq('id', projectId);
    }

    return res.status(200).json({
      success: true,
      data: {
        project:        updated,
        floor_plan_url: publicUrl,
        detected_rooms: detectedRooms,
        walls:          detectedWalls,
        openings:       detectedOpenings,
        ai_detected:    detectedRooms.length > 0 || detectedWalls.length > 0,
      },
    });

  } catch (err) {
    console.error('Upload floor plan error:', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

// ─── Step 3: Save reviewed rooms ──────────────────────────────────────────────
// PUT /projects/:id/rooms

export async function saveRooms(req: AuthRequest, res: Response) {
  try {
    const userId    = req.user!.id;
    const projectId = String(req.params.id);
    const { rooms } = req.body as SaveRoomsInput;

    const project = await verifyOwnership(projectId, userId);
    if (!project) {
      return res.status(404).json({ success: false, error: 'Project not found' });
    }

    // Preserve existing Roboflow data — only update rooms
    const existing = (project.room_data as any) ?? {};
    const { data, error } = await supabase
      .from('projects')
      .update({
        room_data: {
          ...existing,
          rooms,
        },
        updated_at: new Date().toISOString(),
      })
      .eq('id', projectId)
      .select()
      .single();

    if (error) {
      return res.status(400).json({ success: false, error: error.message });
    }

    return res.status(200).json({
      success: true,
      data: { project: data, rooms },
    });

  } catch (err) {
    console.error('Save rooms error:', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

// ─── Step 4: Save room dimensions ─────────────────────────────────────────────
// PUT /projects/:id/dimensions

export async function saveDimensions(req: AuthRequest, res: Response) {
  try {
    const userId    = req.user!.id;
    const projectId = String(req.params.id);
    const { rooms } = req.body as SaveDimensionsInput;

    const project = await verifyOwnership(projectId, userId);
    if (!project) {
      return res.status(404).json({ success: false, error: 'Project not found' });
    }

    const existingRooms: Room[] = (project.room_data as any)?.rooms ?? [];
    const dimensionMap = new Map(rooms.map(r => [r.id, r]));

    const mergedRooms = existingRooms.map(room => {
      const dims = dimensionMap.get(room.id);
      return dims ? { ...room, ...dims } : room;
    });

    const totalArea = computeTotalArea(mergedRooms);

    // Preserve existing Roboflow data — only update rooms and total_area
    const existing = (project.room_data as any) ?? {};
    const { data, error } = await supabase
      .from('projects')
      .update({
        room_data: {
          ...existing,
          rooms: mergedRooms,
          total_area_m2: totalArea,
        },
        updated_at: new Date().toISOString(),
      })
      .eq('id', projectId)
      .select()
      .single();

    if (error) {
      return res.status(400).json({ success: false, error: error.message });
    }

    return res.status(200).json({
      success: true,
      data: { project: data, rooms: mergedRooms, total_area_m2: totalArea },
    });

  } catch (err) {
    console.error('Save dimensions error:', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

// ─── Step 5: Confirm project ──────────────────────────────────────────────────
// POST /projects/:id/confirm

export async function confirmProject(req: AuthRequest, res: Response) {
  try {
    const userId    = req.user!.id;
    const projectId = String(req.params.id);

    const project = await verifyOwnership(projectId, userId);
    if (!project) {
      return res.status(404).json({ success: false, error: 'Project not found' });
    }

    if (!project.floor_plan_url) {
      return res.status(400).json({
        success: false,
        error: 'Floor plan is required before confirming.',
        code:  'MISSING_FLOOR_PLAN',
      });
    }

    const rooms: Room[] = (project.room_data as any)?.rooms ?? [];
    if (rooms.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Rooms are required before confirming.',
        code:  'MISSING_ROOMS',
      });
    }

    const { data: confirmed, error } = await supabase
      .from('projects')
      .update({
        status:     'active',
        updated_at: new Date().toISOString(),
      })
      .eq('id', projectId)
      .select()
      .single();

    if (error) {
      return res.status(400).json({ success: false, error: error.message });
    }

    const roomsSummary = rooms.map(r => ({
      name:       r.name,
      dimensions: `${r.length ?? '-'} × ${r.width ?? '-'} × ${r.height ?? '-'} m`,
      area_m2:    r.length && r.width ? parseFloat((r.length * r.width).toFixed(1)) : null,
    }));

    return res.status(200).json({
      success: true,
      data: {
        project:       confirmed,
        rooms_summary: roomsSummary,
        total_area_m2: (project.room_data as any)?.total_area_m2 ?? 0,
      },
    });

  } catch (err) {
    console.error('Confirm project error:', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

// ─── Standard CRUD ────────────────────────────────────────────────────────────

export async function getProjects(req: AuthRequest, res: Response) {
  try {
    const userId = req.user!.id;
    const limit  = req.query.limit ? parseInt(req.query.limit as string) : undefined;

    const query = supabase
      .from('projects')
      .select('id, name, project_type, address, thumbnail_url, floor_plan_url, status, room_data, created_at, updated_at')
      .eq('user_id', userId)
      .order('updated_at', { ascending: false });

    if (limit) query.limit(limit);

    const { data, error } = await query;
    if (error) return res.status(400).json({ success: false, error: error.message });

    return res.status(200).json({ success: true, data: { projects: data } });

  } catch (err) {
    console.error('Get projects error:', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

export async function getProject(req: AuthRequest, res: Response) {
  try {
    const userId    = req.user!.id;
    const projectId = String(req.params.id);

    const { data, error } = await supabase
      .from('projects')
      .select('*')
      .eq('id', projectId)
      .eq('user_id', userId)
      .single();

    if (error || !data) {
      return res.status(404).json({ success: false, error: 'Project not found' });
    }

    return res.status(200).json({ success: true, data: { project: data } });

  } catch (err) {
    console.error('Get project error:', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

export async function updateProject(req: AuthRequest, res: Response) {
  try {
    const userId    = req.user!.id;
    const projectId = String(req.params.id);
    const updates   = req.body as UpdateProjectInput;

    const project = await verifyOwnership(projectId, userId);
    if (!project) {
      return res.status(404).json({ success: false, error: 'Project not found' });
    }

    const { data, error } = await supabase
      .from('projects')
      .update({ ...updates, updated_at: new Date().toISOString() })
      .eq('id', projectId)
      .select()
      .single();

    if (error) return res.status(400).json({ success: false, error: error.message });

    return res.status(200).json({ success: true, data: { project: data } });

  } catch (err) {
    console.error('Update project error:', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

export async function deleteProject(req: AuthRequest, res: Response) {
  try {
    const userId    = req.user!.id;
    const projectId = String(req.params.id);

    const project = await verifyOwnership(projectId, userId);
    if (!project) {
      return res.status(404).json({ success: false, error: 'Project not found' });
    }

    const { error } = await supabase
      .from('projects')
      .delete()
      .eq('id', projectId)
      .eq('user_id', userId);

    if (error) return res.status(400).json({ success: false, error: error.message });

    return res.status(200).json({ success: true, message: 'Project deleted successfully' });

  } catch (err) {
    console.error('Delete project error:', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

// ─── Generate an AI render image from the user's prompt + current room layout ─
// Every `model` value currently routes to the same Gemini image model
// (gemini-2.5-flash-image, aka "Nano Banana") — see GenerateRenderInput schema
// comment. Swapping in real per-provider routing later only touches this
// function; the request/response contract for the frontend stays the same.

function buildRoomContextSummary(rooms: Room[]): string {
  if (!rooms || rooms.length === 0) return '';

  const lines = rooms.map(r => {
    const dims = (r.length && r.width) ? ` (${r.length}m x ${r.width}m)` : '';
    return `- ${r.name}${dims}`;
  });

  return `The floor plan contains the following rooms:\n${lines.join('\n')}`;
}

interface GeminiImageResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        text?: string;
        inlineData?: { data: string; mimeType: string };
      }>;
    };
  }>;
}

export async function callGeminiImageModel(
  prompt: string,
  referenceImage?: { data: string; mimeType: string } | null
): Promise<{ base64: string; mimeType: string }> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY is not set');

  const requestParts: Array<{ text: string } | { inlineData: { data: string; mimeType: string } }> = [
    { text: prompt },
  ];
  if (referenceImage) {
    requestParts.push({ inlineData: { data: referenceImage.data, mimeType: referenceImage.mimeType } });
  }

  // Using the raw REST endpoint here (rather than the @google/generative-ai
  // SDK used elsewhere in this file) since image generation via
  // responseModalities is a newer capability and the REST contract is the
  // most stable reference for it — see ai.google.dev/gemini-api/docs/image-generation
  const response = await fetch(
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent',
    {
      method:  'POST',
      headers: {
        'x-goog-api-key': apiKey,
        'Content-Type':   'application/json',
      },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: requestParts }],
        generationConfig: { responseModalities: ['TEXT', 'IMAGE'] },
      }),
    }
  );

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Gemini image generation failed (${response.status}): ${errText}`);
  }

  const json = await response.json() as GeminiImageResponse;
  const responseParts = json.candidates?.[0]?.content?.parts ?? [];
  const imagePart = responseParts.find(
    (p): p is { inlineData: { data: string; mimeType: string } } => !!p.inlineData?.data
  );

  if (!imagePart) {
    throw new Error('Gemini did not return an image. It may have refused the prompt.');
  }

  return {
    base64:   imagePart.inlineData.data,
    mimeType: imagePart.inlineData.mimeType || 'image/png',
  };
}

export async function generateRender(req: AuthRequest, res: Response) {
  try {
    const userId    = req.user!.id;
    const projectId = String(req.params.id);
    const { prompt, model } = req.body as GenerateRenderInput;

    const project = await verifyOwnership(projectId, userId);
    if (!project) {
      return res.status(404).json({ success: false, error: 'Project not found' });
    }

    const rooms = (project.room_data as any)?.rooms ?? [];
    const roomContext = buildRoomContextSummary(rooms);

    const fullPrompt = [
      'Generate a photorealistic interior design render based on this floor plan and the following request.',
      roomContext,
      `Design request: ${prompt}`,
    ].filter(Boolean).join('\n\n');

    let image: { base64: string; mimeType: string };
    try {
      image = await callGeminiImageModel(fullPrompt);
    } catch (genErr: any) {
      console.error('Image generation error:', genErr);
      return res.status(502).json({
        success: false,
        error: genErr.message || 'Image generation failed. Please try again.',
      });
    }

    // Upload the generated image to Supabase Storage, same bucket/convention
    // used for uploaded floor plans, so renders persist and have a stable URL.
    const ext = image.mimeType.split('/')[1] || 'png';
    const storagePath = `renders/${userId}/${projectId}-${Date.now()}.${ext}`;
    const buffer = Buffer.from(image.base64, 'base64');

    const { error: uploadError } = await supabase.storage
      .from('nooi-projects')
      .upload(storagePath, buffer, {
        contentType: image.mimeType,
        upsert: true,
      });

    if (uploadError) {
      return res.status(500).json({ success: false, error: uploadError.message });
    }

    const { data: { publicUrl } } = supabase.storage
      .from('nooi-projects')
      .getPublicUrl(storagePath);

    // Persist the generation so it appears in the dashboard's Recent Creations.
    // Fire-and-forget — non-fatal if it fails.
    saveGeneration(userId, projectId, prompt, publicUrl, model ?? 'gemini', 'prompt-render');

    return res.status(200).json({
      success: true,
      data: {
        image_url: publicUrl,
        model_requested: model, // echoed back; not yet used to pick a provider
      },
    });

  } catch (err) {
    console.error('Generate render error:', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}