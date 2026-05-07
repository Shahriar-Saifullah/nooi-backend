import { z } from 'zod';

const userTypes = [
  'home_owner',
  'tenant',
  'interior_designer_architect',
  'design_student',
  'brand_merchant',
  'manufacturer',
  'builder_real_estate',
  'carpenter',
  'contractor',
] as const;

const projectTypes = [
  'full_home_renovation',
  'single_room_redesign',
  'new_construction',
  'furniture_shopping',
  'decor_updates',
  'space_planning',
  'color_consultation',
  'just_browsing',
  'other',
] as const;

export const onboardingSchema = z.object({
  user_type: z.enum(userTypes),
  project_types: z.array(z.enum(projectTypes))
    .min(1, 'Please select at least one project type'),
  interested_topics: z.array(z.string())
    .min(1, 'Please select at least one topic'),
});

export type OnboardingInput = z.infer<typeof onboardingSchema>;