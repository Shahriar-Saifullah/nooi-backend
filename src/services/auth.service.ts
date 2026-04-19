import { supabase } from './supabase';
import { LoginDto, UserResponse } from '../types/auth.types';
import { User } from '@supabase/supabase-js';

export class AuthService {
  private static sanitizeUser(user: User): UserResponse {
    return {
      id: user.id,
      email: user.email || '',
      full_name: user.user_metadata?.full_name || 'No Name',
    };
  }

  static async login({ email, password }: LoginDto) {
    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (error) throw error;

    return {
      user: this.sanitizeUser(data.user),
      session: data.session, // We still return session to the route so it can set the cookie
    };
  }

  static async getMe(token: string): Promise<UserResponse> {
    const { data: { user }, error } = await supabase.auth.getUser(token);
    
    if (error || !user) throw error || new Error('User not found');
    return this.sanitizeUser(user);
  }

  static async logout() {
    const { error } = await supabase.auth.signOut();
    if (error) throw error;
  }
}
