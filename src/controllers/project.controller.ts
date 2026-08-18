import { Request, Response } from 'express';
import crypto from 'crypto';
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

// ─── Floor plan detection — delegates to Python microservice ─────────────────
// The Python service (nooi-floorplan-service) uses OpenCV for pixel-accurate
// wall detection, room region extraction, and door/window detection.
// Gemini is called by the Python service for room naming only.
// Falls back to Roboflow-only detection if the Python service is unavailable.

// Room + the true-shape polygon from the v3 pipeline ([x%, y%] pairs)
type DetectedRoom = Room & { polygon?: [number, number][] };

interface DetectionResult {
  rooms:      DetectedRoom[];
  walls:      Array<{ id?: string; x1: number; y1: number; x2: number; y2: number; thickness: number }>;
  openings:   Array<{ type: 'door'|'window'; wall: 'horizontal'|'vertical'; x: number; y: number; width: number; wall_id?: string }>;
  imgW:       number;
  imgH:       number;
  scaleMPerPx: number | null;
}

async function callFloorPlanService(
  imageUrl: string,
  projectId: string,
): Promise<DetectionResult | null> {
  const serviceUrl = process.env.FLOORPLAN_SERVICE_URL;
  if (!serviceUrl) {
    console.warn('FLOORPLAN_SERVICE_URL not set — skipping Python service');
    return null;
  }

  try {
    const res = await fetch(`${serviceUrl}/analyse`, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'X-Service-Key': process.env.FLOORPLAN_SERVICE_KEY || '',
      },
      body: JSON.stringify({
        image_url:      imageUrl,
        project_id:     projectId,
        gemini_api_key: process.env.GEMINI_API_KEY || '',
      }),
      signal: AbortSignal.timeout(120_000), // 2 min timeout
    });

    if (!res.ok) {
      const err = await res.text();
      console.error(`Floor plan service error ${res.status}: ${err.slice(0, 200)}`);
      return null;
    }

    const data = await res.json() as any;
    if (!data.success) {
      console.error('Floor plan service returned failure:', data.error);
      return null;
    }

    console.log(
      `Python service: ${data.rooms?.length} rooms, ` +
      `${data.walls?.length} walls, ${data.openings?.length} openings`
    );

    // Convert service response to DetectionResult format
    const rooms: DetectedRoom[] = (data.rooms || []).map((r: any) => ({
      id:         r.id,
      name:       r.name,
      confidence: r.confidence ?? 70,
      color:      r.color ?? '#e5e7eb',
      box:        r.box,
      polygon:    r.polygon,          // v3: true room shape ([x%, y%] pairs)
      length:     r.length,
      width:      r.width,
    }));

    return {
      rooms,
      walls:    data.walls    || [],
      openings: data.openings || [],   // v3: each carries wall_id
      imgW:     data.image_size?.width  || 1000,
      imgH:     data.image_size?.height || 1000,
      scaleMPerPx: data.scale_m_per_px ?? null,
    };
  } catch (err) {
    console.error('Floor plan service call failed:', err);
    return null;
  }
}

// Roboflow fallback — used when Python service is unavailable
interface RoboflowPrediction {
  x: number; y: number; width: number; height: number;
  class: 'wall' | 'door' | 'window'; confidence: number;
}

async function callRoboflow(imageUrl: string): Promise<{
  walls: RoboflowPrediction[];
  doors: RoboflowPrediction[];
  windows: RoboflowPrediction[];
  imgW: number; imgH: number;
} | null> {
  const apiKey = process.env.ROBOFLOW_API_KEY;
  if (!apiKey) return null;

  try {
    const imgRes = await fetch(imageUrl);
    if (!imgRes.ok) return null;
    const imgBuffer = await imgRes.arrayBuffer();
    const base64 = Buffer.from(imgBuffer).toString('base64');

    const res = await fetch(
      `https://serverless.roboflow.com/cubicasa5k-2-qpmsa/6?api_key=${apiKey}`,
      { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: base64 }
    );
    if (!res.ok) return null;
    const result = await res.json() as any;
    const preds = result.predictions || [];

    console.log(`Roboflow: ${preds.filter((p:any)=>p.class==='wall').length} walls, ` +
      `${preds.filter((p:any)=>p.class==='door').length} doors, ` +
      `${preds.filter((p:any)=>p.class==='window').length} windows`);

    return {
      walls:   preds.filter((p:any) => p.class === 'wall'),
      doors:   preds.filter((p:any) => p.class === 'door'),
      windows: preds.filter((p:any) => p.class === 'window'),
      imgW:    result.image?.width  || 1000,
      imgH:    result.image?.height || 1000,
    };
  } catch (err) {
    console.error('Roboflow call failed:', err);
    return null;
  }
}

async function detectRooms(floorPlanUrl: string, projectId: string): Promise<DetectionResult> {
  // ── Primary: Python microservice (OpenCV + Gemini naming) ──
  const serviceResult = await callFloorPlanService(floorPlanUrl, projectId);
  if (serviceResult && (serviceResult.rooms.length > 0 || serviceResult.walls.length > 0)) {
    return serviceResult;
  }

  // ── Fallback: Roboflow for walls/doors/windows + Gemini for room naming ──
  console.warn('Python service unavailable — falling back to Roboflow + Gemini');

  const rf = await callRoboflow(floorPlanUrl);
  const imgW = rf?.imgW || 1000;
  const imgH = rf?.imgH || 1000;

  // Gemini room naming fallback
  const geminiKey = process.env.GEMINI_API_KEY || '';
  let rooms: Room[] = [];

  if (geminiKey) {
    const { GoogleGenerativeAI } = await import('@google/generative-ai');
    const genAI = new GoogleGenerativeAI(geminiKey);
    const model = genAI.getGenerativeModel({
      model: 'gemini-2.5-flash',
      generationConfig: { responseMimeType: 'application/json' },
    });

    const imgRes = await fetch(floorPlanUrl);
    const imgBuf = await imgRes.arrayBuffer();
    const b64    = Buffer.from(imgBuf).toString('base64');
    const mime   = (imgRes.headers.get('content-type') || 'image/png').split(';')[0];

    const prompt = `Analyse this floor plan. List all rooms as JSON array.
Each: {"name":"unique name","confidence":0-100,"box_2d":[ymin,xmin,ymax,xmax],"color":"hex","dimensions":{"length":0,"width":0,"unit":"ft"}|null}
0-1000 scale. Unique names only. Return ONLY the JSON array.`;

    const delays = [3000, 6000, 10000];
    for (let attempt = 0; attempt <= delays.length; attempt++) {
      try {
        const result = await model.generateContent([
          { text: prompt },
          { inlineData: { data: b64, mimeType: mime } },
        ]);
        const raw = result.response.text().trim();
        const parsed = JSON.parse(raw.slice(raw.indexOf('['), raw.lastIndexOf(']')+1));
        const FT = 0.3048;
        rooms = parsed.map((r: any, i: number) => {
          const box = r.box_2d ? {
            top:    Math.max(0,Math.min(100,r.box_2d[0]/10)),
            left:   Math.max(0,Math.min(100,r.box_2d[1]/10)),
            width:  Math.max(0,Math.min(100,(r.box_2d[3]-r.box_2d[1])/10)),
            height: Math.max(0,Math.min(100,(r.box_2d[2]-r.box_2d[0])/10)),
          } : undefined;
          return {
            id: `${projectId}-r${i+1}`, name: r.name,
            confidence: Math.round(r.confidence||70),
            color: r.color||'#e5e7eb', box,
            length: r.dimensions ? parseFloat((r.dimensions.length*(r.dimensions.unit==='ft'?FT:1)).toFixed(2)) : undefined,
            width:  r.dimensions ? parseFloat((r.dimensions.width *(r.dimensions.unit==='ft'?FT:1)).toFixed(2)) : undefined,
          };
        });
        break;
      } catch (err: any) {
        if (err?.status===503 && attempt < delays.length) {
          await new Promise(r => setTimeout(r, delays[attempt]));
        } else { break; }
      }
    }
  }

  // Convert Roboflow walls/openings
  const walls = rf ? rf.walls.map(w => {
    const isH = w.width > w.height;
    return isH
      ? { x1:(w.x-w.width/2)/imgW*100, y1:w.y/imgH*100, x2:(w.x+w.width/2)/imgW*100, y2:w.y/imgH*100, thickness:Math.max(0.5,w.height/imgH*100) }
      : { x1:w.x/imgW*100, y1:(w.y-w.height/2)/imgH*100, x2:w.x/imgW*100, y2:(w.y+w.height/2)/imgH*100, thickness:Math.max(0.5,w.width/imgW*100) };
  }) : [];

  const openings = rf ? [
    ...rf.doors.map(d => ({
      type: 'door' as const,
      wall: (d.width>d.height?'horizontal':'vertical') as 'horizontal'|'vertical',
      x: d.x/imgW*1000, y: d.y/imgH*1000,
      width: Math.max(80, Math.max(d.width,d.height)/Math.max(imgW,imgH)*1000),
    })),
    ...rf.windows.map(w => ({
      type: 'window' as const,
      wall: (w.width>w.height?'horizontal':'vertical') as 'horizontal'|'vertical',
      x: w.x/imgW*1000, y: w.y/imgH*1000,
      width: Math.max(60, Math.max(w.width,w.height)/Math.max(imgW,imgH)*1000),
    })),
  ] : [];

  return { rooms, walls, openings, imgW, imgH, scaleMPerPx: null };
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
    let detectedRooms: DetectedRoom[] = [];
    let detectedOpenings: DetectionResult['openings'] = [];
    let detectedWalls: DetectionResult['walls'] = [];
    let imgW = 1000; let imgH = 1000;
    let scaleMPerPx: number | null = null;
    try {
      const detection = await detectRooms(publicUrl, projectId);
      detectedRooms    = detection.rooms;
      detectedOpenings = detection.openings;
      detectedWalls    = detection.walls;
      imgW             = detection.imgW;
      imgH             = detection.imgH;
      scaleMPerPx      = detection.scaleMPerPx;
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
            scale_m_per_px: scaleMPerPx,
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

// ── Save furniture placements (3D scene state) ───────────────────────────────
// Placements live in room_data.furniture; each item carries the catalog
// modelId plus position/rotation/customization so the scene restores exactly.
export async function saveFurniture(req: AuthRequest, res: Response) {
  try {
    const userId    = req.user!.id;
    const projectId = String(req.params.id);
    const { furniture, wall_colors, wall_surfaces, door_finishes } = req.body as {
      furniture: unknown[];
      wall_colors?: Record<string, string>;
      wall_surfaces?: Record<string, string>;
      door_finishes?: Record<string, string>;
    };

    const project = await verifyOwnership(projectId, userId);
    if (!project) {
      return res.status(404).json({ success: false, error: 'Project not found' });
    }

    const existing = (project.room_data as any) ?? {};
    const { data, error } = await supabase
      .from('projects')
      .update({
        room_data: {
          ...existing,
          furniture,
          ...(wall_colors !== undefined ? { wall_colors } : {}),
          ...(wall_surfaces !== undefined ? { wall_surfaces } : {}),
          ...(door_finishes !== undefined ? { door_finishes } : {}),
        },
        updated_at: new Date().toISOString(),
      })
      .eq('id', projectId)
      .select()
      .single();

    if (error) {
      return res.status(400).json({ success: false, error: error.message });
    }
    return res.json({ success: true, data: { furniture } });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message });
  }
}

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

// ─── Sharing: public read-only links ─────────────────────────────────────────
// POST /projects/:id/share  { enabled: boolean }
// Generates an unguessable token the first time sharing is enabled; toggling
// off keeps the token so re-enabling restores the same link.
export async function toggleShare(req: AuthRequest, res: Response) {
  try {
    const userId    = req.user!.id;
    const projectId = String(req.params.id);
    const { enabled } = req.body as { enabled: boolean };

    const project = await verifyOwnership(projectId, userId);
    if (!project) {
      return res.status(404).json({ success: false, error: 'Project not found' });
    }

    // fetch current token (verifyOwnership doesn't select it)
    const { data: row } = await supabase
      .from('projects')
      .select('share_token')
      .eq('id', projectId)
      .single();

    const share_token =
      row?.share_token ?? crypto.randomBytes(24).toString('base64url');

    const { error } = await supabase
      .from('projects')
      .update({
        share_token,
        share_enabled: enabled,
        updated_at: new Date().toISOString(),
      })
      .eq('id', projectId);

    if (error) {
      return res.status(400).json({ success: false, error: error.message });
    }
    return res.json({ success: true, data: { share_enabled: enabled, share_token } });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message });
  }
}

// GET /shared/:token — PUBLIC, no auth.
// Returns only what the read-only viewer needs; never the owner's identity.
export async function getSharedProject(req: Request, res: Response) {
  try {
    const token = String(req.params.token || '');
    // base64url of 24 bytes = 32 chars; reject junk early
    if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) {
      return res.status(404).json({ success: false, error: 'Not found' });
    }

    const { data, error } = await supabase
      .from('projects')
      .select('name, project_type, room_data, updated_at')
      .eq('share_token', token)
      .eq('share_enabled', true)
      .single();

    if (error || !data) {
      return res.status(404).json({ success: false, error: 'Not found' });
    }
    return res.json({ success: true, data: { project: data } });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message });
  }
}

// ─── AI furnish: natural-language furniture placement ────────────────────────
// POST /projects/:id/ai-furnish
// The frontend sends room rectangles in WORLD coordinates (meters, plan
// centered on the origin) plus a compact catalog summary; Gemini picks a
// room + layout; we validate ids and clamp every item inside the room.
export async function aiFurnish(req: AuthRequest, res: Response) {
  try {
    const userId    = req.user!.id;
    const projectId = String(req.params.id);
    const { command, rooms, catalog, existing } = req.body as {
      command: string;
      rooms: {
        id: string; name: string;
        rect: { x: number; z: number; w: number; d: number };
        polygon?: [number, number][];
      }[];
      catalog: { id: string; name: string; category: string; w: number; d: number; h?: number }[];
      existing?: { name: string; x: number; z: number }[];
    };

    const project = await verifyOwnership(projectId, userId);
    if (!project) {
      return res.status(404).json({ success: false, error: 'Project not found' });
    }

    const geminiKey = process.env.GEMINI_API_KEY || '';
    if (!geminiKey) {
      return res.status(503).json({ success: false, error: 'AI service not configured' });
    }

    const prompt = `You are an expert interior designer placing furniture on a floor plan.

USER COMMAND: "${command}"

ROOMS (world coordinates in meters; rect = {x: left edge, z: top edge, w: width along x, d: depth along z}; +x is right, +z is down when viewed from above):
${JSON.stringify(rooms)}

AVAILABLE FURNITURE CATALOG (footprint in cm, w = width, d = depth):
${JSON.stringify(catalog)}

EXISTING FURNITURE ALREADY PLACED (do not overlap these):
${JSON.stringify(existing ?? [])}

TASK: Identify which room the user means (match names loosely — "master bedroom" matches "MASTER BED RM"). Choose 4-10 appropriate catalog items for that room type and the user's wishes, and lay them out realistically:
- beds centered against a wall, nightstands flanking the bed
- wardrobes/dressers/bookshelves/TV stands flat against walls
- sofas facing coffee tables/TV, rug under or in front of seating
- dining chairs around dining tables
- leave walking clearance; nothing outside the room; nothing overlapping
- some rooms are non-rectangular (an L-shape's bounding rect includes area outside the room) — when in doubt keep items closer to the room's center
- keep at least 40cm clearance between separate items (exception: rugs may sit under beds, sofas and tables)
- positions are the CENTER of each item, in world meters
- rotation in degrees, one of 0, 90, 180, 270 (rotation about the vertical axis; at 0 the item's w spans the x axis)

Respond with ONLY a JSON object, no markdown fences, in exactly this shape:
{"targetRoomId": "<room id>", "message": "<one friendly sentence describing what you placed>", "placements": [{"modelId": "<catalog id>", "x": <number>, "z": <number>, "rotation": 0}]}
If no room matches the command, respond: {"error": "<short explanation>"}`;

    const { GoogleGenerativeAI } = await import('@google/generative-ai');
    const genAI = new GoogleGenerativeAI(geminiKey);

    // Gemini occasionally 503s under load ("high demand"). Retry with backoff,
    // then fall back to the previous-generation flash model, then to NVIDIA NIM
    // (OpenAI-compatible) if a key is configured, before giving up.
    const MODELS = ['gemini-2.5-flash', 'gemini-2.0-flash'];
    let raw: string | null = null;
    let lastErr: any = null;
    attempts: for (const modelName of MODELS) {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const model = genAI.getGenerativeModel({ model: modelName });
          const result = await model.generateContent(prompt);
          raw = result.response.text().replace(/```json|```/g, '').trim();
          break attempts;
        } catch (e: any) {
          lastErr = e;
          const msg = String(e?.message || '');
          const transient =
            msg.includes('503') || msg.includes('429') ||
            /overloaded|high demand|unavailable|fetch failed|ECONNRESET|timeout/i.test(msg);
          if (!transient) break attempts; // config/auth errors: fail fast, don't hammer
          await new Promise(r => setTimeout(r, 700 * (attempt + 1)));
        }
      }
    }

    // ── Fallback: NVIDIA NIM (build.nvidia.com), OpenAI-compatible ───────────
    // Note: NVIDIA's hosted catalog is a free *prototyping* tier (~40 req/min);
    // their terms reserve production serving for AI Enterprise. Fine as a
    // last-resort fallback, not as the primary provider.
    const nvidiaKey = process.env.NVIDIA_API_KEY || '';
    if (raw === null && nvidiaKey) {
      try {
        const nvRes = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${nvidiaKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: process.env.NVIDIA_MODEL || 'meta/llama-3.3-70b-instruct',
            messages: [
              { role: 'system', content: 'You are an interior designer. Reply with raw JSON only — no markdown fences, no commentary.' },
              { role: 'user', content: prompt },
            ],
            temperature: 0.4,
            max_tokens: 2048,
          }),
        });
        if (nvRes.ok) {
          const nvJson: any = await nvRes.json();
          const text = nvJson?.choices?.[0]?.message?.content;
          if (typeof text === 'string' && text.trim()) {
            raw = text.replace(/```json|```/g, '').trim();
          }
        } else {
          lastErr = new Error(`NVIDIA NIM ${nvRes.status}`);
        }
      } catch (e: any) {
        lastErr = e;
      }
    }
    if (raw === null) {
      const msg = String(lastErr?.message || '');
      const busy = msg.includes('503') || /overloaded|high demand/i.test(msg);
      return res.status(busy ? 503 : 502).json({
        success: false,
        error: busy
          ? 'The AI is busy right now — please try again in a moment.'
          : 'AI request failed — please try again.',
      });
    }

    let parsed: any;
    try { parsed = JSON.parse(raw); }
    catch {
      return res.status(502).json({ success: false, error: 'AI returned an unreadable layout - try rephrasing.' });
    }
    if (parsed.error) {
      return res.status(422).json({ success: false, error: String(parsed.error) });
    }

    const room = rooms.find(r => r.id === parsed.targetRoomId);
    if (!room || !Array.isArray(parsed.placements)) {
      return res.status(502).json({ success: false, error: 'AI response did not match the floor plan - try again.' });
    }

    // ── Layout sanitizer ─────────────────────────────────────────────────────
    // Gemini's coordinates are suggestions; geometry here is law. Each item's
    // FULL footprint (all four corners, rotation-aware) must lie inside the
    // room, and footprints may not overlap each other (flat items like rugs
    // are exempt — they belong under beds and sofas).

    // ray-casting point-in-polygon test (world coords)
    const insidePolygon = (x: number, z: number, poly: [number, number][]) => {
      let inside = false;
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const [xi, zi] = poly[i], [xj, zj] = poly[j];
        if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) {
          inside = !inside;
        }
      }
      return inside;
    };
    const polyCentroid = (poly: [number, number][]): [number, number] => {
      const n = poly.length;
      return [
        poly.reduce((s, p) => s + p[0], 0) / n,
        poly.reduce((s, p) => s + p[1], 0) / n,
      ];
    };

    const MARGIN = 0.05; // 5cm off the walls minimum
    const rect = room.rect;
    const poly = room.polygon && room.polygon.length >= 3 ? room.polygon : null;
    const interior: [number, number] = poly
      ? polyCentroid(poly)
      : [rect.x + rect.w / 2, rect.z + rect.d / 2];

    /** whole footprint inside the room (rect margins + polygon corners)? */
    const EPS = 1e-3; // 1mm float tolerance — exact-margin placements must pass
    const fits = (x: number, z: number, hw: number, hd: number) => {
      if (x - hw < rect.x + MARGIN - EPS || x + hw > rect.x + rect.w - MARGIN + EPS) return false;
      if (z - hd < rect.z + MARGIN - EPS || z + hd > rect.z + rect.d - MARGIN + EPS) return false;
      if (poly) {
        const corners: [number, number][] = [
          [x - hw, z - hd], [x + hw, z - hd], [x - hw, z + hd], [x + hw, z + hd],
        ];
        for (const [cx, cz] of corners) {
          if (!insidePolygon(cx, cz, poly)) return false;
        }
      }
      return true;
    };

    type Accepted = { modelId: string; x: number; z: number; rotation: number; hw: number; hd: number; flat: boolean };
    const accepted: Accepted[] = [];
    const GAP = 0.02; // 2cm breathing room between footprints

    const overlapsAny = (x: number, z: number, hw: number, hd: number) =>
      accepted.find(a =>
        !a.flat &&
        Math.abs(x - a.x) < hw + a.hw + GAP &&
        Math.abs(z - a.z) < hd + a.hd + GAP,
      );

    /** last-resort placement: scan the room grid for the nearest position that
        fits the walls and (unless flat) overlaps nothing already accepted */
    const findSpot = (px: number, pz: number, hw: number, hd: number, flat: boolean) => {
      const STEP = 0.2; // 20cm grid
      let best: [number, number] | null = null;
      let bestDist = Infinity;
      for (let x = rect.x + hw + MARGIN; x <= rect.x + rect.w - hw - MARGIN + 1e-9; x += STEP) {
        for (let z = rect.z + hd + MARGIN; z <= rect.z + rect.d - hd - MARGIN + 1e-9; z += STEP) {
          if (!fits(x, z, hw, hd)) continue;
          if (!flat && overlapsAny(x, z, hw, hd)) continue;
          const d = (x - px) ** 2 + (z - pz) ** 2;
          if (d < bestDist) { bestDist = d; best = [x, z]; }
        }
      }
      return best;
    };

    const catalogMap = new Map(catalog.map(c => [c.id, c]));
    for (const p of (parsed.placements as any[]).slice(0, 15)) {
      const cat = catalogMap.get(String(p.modelId));
      if (!cat) continue;
      const rot = [0, 90, 180, 270].includes(Number(p.rotation)) ? Number(p.rotation) : 0;
      const hw = ((rot % 180 === 0 ? cat.w : cat.d) / 100) / 2;
      const hd = ((rot % 180 === 0 ? cat.d : cat.w) / 100) / 2;
      const flat = (cat.h ?? 100) <= 5; // rugs etc: no collision either way
      let x = Number(p.x) || interior[0];
      let z = Number(p.z) || interior[1];

      // 1) wall containment: pull toward the room interior until the whole
      //    footprint fits; drop if it never does (item too big / bad room)
      if (!fits(x, z, hw, hd)) {
        let ok = false;
        for (let t = 0.05; t <= 1.0; t += 0.05) {
          const nx = x + (interior[0] - x) * t;
          const nz = z + (interior[1] - z) * t;
          if (fits(nx, nz, hw, hd)) { x = nx; z = nz; ok = true; break; }
        }
        if (!ok) {
          // e.g. an L-shaped room where the pull path never clears the notch —
          // scan for the nearest position anywhere in the room instead
          const spot = findSpot(x, z, hw, hd, flat);
          if (!spot) continue;
          [x, z] = spot; ok = true;
        }
      }

      // 2) collision resolution: push out of overlapping neighbours along the
      //    minimal-separation axis, re-checking walls after every push
      let placed = flat || !overlapsAny(x, z, hw, hd);
      if (!placed) {
        for (let attempt = 0; attempt < 8 && !placed; attempt++) {
          const hit = overlapsAny(x, z, hw, hd)!;
          const pushX = (hw + hit.hw + GAP) - Math.abs(x - hit.x);
          const pushZ = (hd + hit.hd + GAP) - Math.abs(z - hit.z);
          const candidates: [number, number][] = pushX <= pushZ
            ? [[x + Math.sign(x - hit.x || 1) * pushX, z], [x - Math.sign(x - hit.x || 1) * pushX, z],
               [x, z + Math.sign(z - hit.z || 1) * pushZ], [x, z - Math.sign(z - hit.z || 1) * pushZ]]
            : [[x, z + Math.sign(z - hit.z || 1) * pushZ], [x, z - Math.sign(z - hit.z || 1) * pushZ],
               [x + Math.sign(x - hit.x || 1) * pushX, z], [x - Math.sign(x - hit.x || 1) * pushX, z]];
          const next = candidates.find(([nx, nz]) => fits(nx, nz, hw, hd));
          if (!next) break;
          [x, z] = next;
          placed = !overlapsAny(x, z, hw, hd);
        }
        if (!placed) {
          const spot = findSpot(x, z, hw, hd, flat);
          if (spot) { [x, z] = spot; placed = true; }
        }
      }
      if (!placed) continue;

      accepted.push({ modelId: cat.id, x, z, rotation: rot, hw, hd, flat });
    }

    const placements = accepted.map(({ modelId, x, z, rotation }) => ({ modelId, x, z, rotation }));

    if (placements.length === 0) {
      return res.status(422).json({ success: false, error: 'No suitable furniture fit that room - try a different request.' });
    }

    return res.json({
      success: true,
      data: {
        targetRoomId: room.id,
        targetRoomName: room.name,
        message: typeof parsed.message === 'string' ? parsed.message : 'Furniture placed.',
        placements,
      },
    });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message });
  }
}

// ─── Render Engine: live 3D scene → Replicate → photorealistic image ─────────
// POST /projects/:id/render-scene  { prompt?, scene_image (data URL) }
// The scene capture conditions an img2img interior-design model, so the output
// matches the user's actual layout, camera angle and wall colors.
export async function renderScene(req: AuthRequest, res: Response) {
  try {
    const userId    = req.user!.id;
    const projectId = String(req.params.id);
    const { prompt, scene_image, depth_image } = req.body as {
      prompt?: string; scene_image: string; depth_image?: string;
    };

    const project = await verifyOwnership(projectId, userId);
    if (!project) {
      return res.status(404).json({ success: false, error: 'Project not found' });
    }

    const token = process.env.REPLICATE_API_TOKEN || '';
    if (!token) {
      return res.status(503).json({ success: false, error: 'Render engine not configured' });
    }
    if (!/^data:image\/(png|jpe?g|webp);base64,/.test(scene_image)) {
      return res.status(400).json({ success: false, error: 'Invalid scene image' });
    }

    // ── Pipeline selection ───────────────────────────────────────────────────
    // RENDER_MODE=depth → depth-ControlNet (geometry from a depth map, full
    //   freedom on materials/lighting; the untextured 3D look can't leak in)
    // RENDER_MODE=color (default) → img2img on the colour capture
    // Switching back is an env var change, not a deploy. The frontend always
    // sends both images, so either path works at any time.
    const useDepth = (process.env.RENDER_MODE || 'color') === 'depth' && !!depth_image;

    const { default: Replicate } = await import('replicate');
    const replicate = new Replicate({ auth: token });

    let model: any;
    let input: Record<string, unknown>;

    if (useDepth) {
      // A depth map carries no colour, so anything the user chose in 3D
      // (wall paint, furniture finish) must be restated in words.
      const fullPrompt = [
        'Photorealistic interior photograph of this exact room.',
        'Follow the depth map precisely for room geometry, camera angle and furniture placement.',
        'High-end architectural photography, natural window light, realistic materials, physically based textures, 8k detail.',
        prompt ? `Style: ${prompt}` : 'Style: warm contemporary interior with natural materials.',
      ].filter(Boolean).join(' ');

      model = process.env.REPLICATE_DEPTH_MODEL || 'black-forest-labs/flux-depth-dev';
      input = {
        control_image: depth_image,
        prompt: fullPrompt,
        guidance: 10,
        num_inference_steps: 28,
        output_format: 'png',
      };
    } else {
      const fullPrompt = [
        'Photorealistic interior photograph of THIS room. Keep the existing room shape, camera angle, window and door positions, wall colours and every piece of furniture exactly where it is — same types, same sizes, same positions.',
        'Only upgrade materials, textures and lighting to look real: high-end architectural photography, natural window light, physically based materials, 8k detail.',
        'Do not add, remove, move or restyle furniture. Do not add chandeliers, curtains or decor that is not already present.',
        prompt ? `Style request: ${prompt}` : '',
      ].filter(Boolean).join(' ');

      // How much the model may rewrite the capture. 0.8 (the old default)
      // preserves only the coarse layout; 0.5–0.6 keeps furniture, colours and
      // proportions much closer. Tune with RENDER_STRENGTH — no deploy needed.
      const strength = Number(process.env.RENDER_STRENGTH ?? 0.55);
      const guidance = Number(process.env.RENDER_GUIDANCE ?? 12);

      model = process.env.REPLICATE_RENDER_MODEL ||
        'adirik/interior-design:76604baddc85b1b4616e1c6475eca080da339c8875bd4996705440484a6eac38';
      input = {
        image: scene_image,
        prompt: fullPrompt,
        negative_prompt:
          'different room, different layout, rearranged furniture, added furniture, removed furniture, chandelier, ornate decor, cartoon, illustration, painting, sketch, low quality, blurry, warped walls, distorted geometry, extra rooms, watermark, text',
        num_inference_steps: 30,
        guidance_scale: Number.isFinite(guidance) ? guidance : 12,
        prompt_strength: Number.isFinite(strength) ? Math.min(0.95, Math.max(0.2, strength)) : 0.55,
      };
    }

    let output: any = null;
    let lastErr: any = null;
    for (let attempt = 0; attempt < 2 && output === null; attempt++) {
      try {
        output = await replicate.run(model, { input });
      } catch (e: any) {
        lastErr = e;
        await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
      }
    }
    if (output === null) {
      console.error('Replicate render error:', lastErr);
      return res.status(502).json({ success: false, error: 'Render engine is busy — please try again.' });
    }

    // replicate-js may return a URL string, an array of them, or FileOutput objects
    const first = Array.isArray(output) ? output[0] : output;
    const outUrl =
      typeof first === 'string' ? first
      : typeof first?.url === 'function' ? String(first.url())
      : String(first);

    const dl = await fetch(outUrl);
    if (!dl.ok) {
      return res.status(502).json({ success: false, error: 'Could not fetch rendered image' });
    }
    const buffer = Buffer.from(await dl.arrayBuffer());

    // Persist to the same bucket/convention as generateRender, so scene renders
    // get stable URLs and show up in Recent Creations alongside prompt renders.
    const storagePath = `renders/${userId}/${projectId}-scene-${Date.now()}.png`;
    const { error: uploadError } = await supabase.storage
      .from('nooi-projects')
      .upload(storagePath, buffer, { contentType: 'image/png', upsert: true });
    if (uploadError) {
      return res.status(500).json({ success: false, error: uploadError.message });
    }
    const { data: { publicUrl } } = supabase.storage
      .from('nooi-projects')
      .getPublicUrl(storagePath);

    saveGeneration(userId, projectId, prompt || 'Scene render', publicUrl,
      useDepth ? 'replicate-flux-depth' : 'replicate-interior', 'scene-render');

    return res.status(200).json({ success: true, data: { image_url: publicUrl } });
  } catch (err) {
    console.error('Scene render error:', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}