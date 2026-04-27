import { Response } from 'express';
import { supabase } from '../services/supabase';
import { AuthRequest } from '../types';
import { CreateProjectInput, UpdateProjectInput } from '../schemas/project.schema';


export async function createProject(req: AuthRequest, res: Response) {
  try {
    const userId = req.user!.id;
    const { name, floor_plan_data, room_data, thumbnail_url } = req.body as CreateProjectInput;

    const { data, error } = await supabase
      .from('projects')
      .insert({
        user_id:        userId,
        name,
        floor_plan_data: floor_plan_data ?? {},
        room_data:       room_data ?? {},
        thumbnail_url:   thumbnail_url ?? null,
        status:          'draft',
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


export async function getProjects(req: AuthRequest, res: Response) {
  try {
    const userId = req.user!.id;

    const { data, error } = await supabase
      .from('projects')
      .select('id, name, thumbnail_url, status, created_at, updated_at')
      .eq('user_id', userId)
      .order('updated_at', { ascending: false });

    if (error) {
      return res.status(400).json({ success: false, error: error.message });
    }

    return res.status(200).json({
      success: true,
      data: { projects: data },
    });

  } catch (err) {
    console.error('Get projects error:', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}


export async function getProject(req: AuthRequest, res: Response) {
  try {
    const userId    = req.user!.id;
    const projectId = req.params.id;

    const { data, error } = await supabase
      .from('projects')
      .select('*')
      .eq('id', projectId)
      .eq('user_id', userId)
      .single();

    if (error || !data) {
      return res.status(404).json({ success: false, error: 'Project not found' });
    }

    return res.status(200).json({
      success: true,
      data: { project: data },
    });

  } catch (err) {
    console.error('Get project error:', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}


export async function updateProject(req: AuthRequest, res: Response) {
  try {
    const userId    = req.user!.id;
    const projectId = req.params.id;
    const updates   = req.body as UpdateProjectInput;

    // Check project belongs to user
    const { data: existing } = await supabase
      .from('projects')
      .select('id')
      .eq('id', projectId)
      .eq('user_id', userId)
      .single();

    if (!existing) {
      return res.status(404).json({ success: false, error: 'Project not found' });
    }

    const { data, error } = await supabase
      .from('projects')
      .update({
        ...updates,
        updated_at: new Date().toISOString(),
      })
      .eq('id', projectId)
      .eq('user_id', userId)
      .select()
      .single();

    if (error) {
      return res.status(400).json({ success: false, error: error.message });
    }

    return res.status(200).json({
      success: true,
      data: { project: data },
    });

  } catch (err) {
    console.error('Update project error:', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}


export async function deleteProject(req: AuthRequest, res: Response) {
  try {
    const userId    = req.user!.id;
    const projectId = req.params.id;

    const { data: existing } = await supabase
      .from('projects')
      .select('id')
      .eq('id', projectId)
      .eq('user_id', userId)
      .single();

    if (!existing) {
      return res.status(404).json({ success: false, error: 'Project not found' });
    }

    const { error } = await supabase
      .from('projects')
      .delete()
      .eq('id', projectId)
      .eq('user_id', userId);

    if (error) {
      return res.status(400).json({ success: false, error: error.message });
    }

    return res.status(200).json({
      success: true,
      message: 'Project deleted successfully',
    });

  } catch (err) {
    console.error('Delete project error:', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}