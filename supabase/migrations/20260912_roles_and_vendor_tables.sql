-- ==============================================================================
-- Migration: Add User Roles and Vendor Profiles
-- Description:
--   1. Adds 'role' column to public.profiles ('user', 'vendor', 'admin', 'super_admin')
--   2. Creates public.vendor_profiles table for vendor business metadata
--   3. Sets up indexes, updated_at trigger, and Row Level Security (RLS)
-- ==============================================================================

-- 1. Ensure profiles table has a role column
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema = 'public' 
      AND table_name = 'profiles' 
      AND column_name = 'role'
  ) THEN
    ALTER TABLE public.profiles 
    ADD COLUMN role VARCHAR(20) DEFAULT 'user' NOT NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_profiles_role ON public.profiles(role);

-- 2. Create vendor_profiles table
CREATE TABLE IF NOT EXISTS public.vendor_profiles (
  id UUID PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
  business_name TEXT NOT NULL,
  business_email TEXT,
  phone TEXT NOT NULL,
  category TEXT NOT NULL,
  website TEXT,
  address TEXT,
  city TEXT,
  country TEXT,
  tax_id TEXT,
  description TEXT,
  logo_url TEXT,
  status VARCHAR(20) DEFAULT 'pending' NOT NULL, -- 'pending', 'approved', 'rejected', 'suspended'
  rejection_reason TEXT,
  verified_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_vendor_profiles_status ON public.vendor_profiles(status);
CREATE INDEX IF NOT EXISTS idx_vendor_profiles_category ON public.vendor_profiles(category);

-- 3. Trigger for updated_at on vendor_profiles
CREATE OR REPLACE FUNCTION public.handle_vendor_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS tr_vendor_profiles_updated_at ON public.vendor_profiles;
CREATE TRIGGER tr_vendor_profiles_updated_at
  BEFORE UPDATE ON public.vendor_profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_vendor_updated_at();

-- 4. Enable Row Level Security (RLS)
ALTER TABLE public.vendor_profiles ENABLE ROW LEVEL SECURITY;

-- Policy: Vendors can read their own profile
CREATE POLICY "Vendors can view own profile"
  ON public.vendor_profiles
  FOR SELECT
  USING (auth.uid() = id);

-- Policy: Vendors can update their own profile
CREATE POLICY "Vendors can update own profile"
  ON public.vendor_profiles
  FOR UPDATE
  USING (auth.uid() = id);

-- Policy: Approved vendors are viewable by authenticated users (for marketplace directory)
CREATE POLICY "Approved vendors are viewable"
  ON public.vendor_profiles
  FOR SELECT
  USING (status = 'approved');

-- Policy: Service role (backend admin client) has full access
CREATE POLICY "Service role full access on vendor_profiles"
  ON public.vendor_profiles
  FOR ALL
  USING (auth.jwt()->>'role' = 'service_role');
