import { ConstitutionData } from './fetch-constitution.js';

export interface RenderOptions {
  communityName: string;
  userName: string;
  adminId: string;
  adminName: string;
  communityStartDate: string;
  constitution: ConstitutionData;
  apiUrl: string;
  mem0Url: string;
}

export function renderClaudeMd(template: string, opts: RenderOptions): string {
  return template
    .replace(/\{\{community_name\}\}/g, opts.communityName)
    .replace(/\{\{admin_id\}\}/g, opts.adminId)
    .replace(/\{\{admin_name\}\}/g, opts.adminName)
    .replace(/\{\{community_start_date\}\}/g, opts.communityStartDate)
    .replace(/\{\{principles_version\}\}/g, opts.constitution.version)
    .replace(/\{\{principles_hash\}\}/g, opts.constitution.content_hash || 'unknown')
    .replace(/\{\{principles_updated_at\}\}/g, opts.constitution.updated_at)
    .replace(/\{\{principles_content\}\}/g, opts.constitution.content)
    .replace(/\{\{charter_content\}\}/g, '(No behavioral charter configured yet)')
    .replace(/\{\{emergentvibe_url\}\}/g, opts.apiUrl)
    .replace(/\{\{slug\}\}/g, opts.constitution.slug)
    .replace(/\{\{last_sync_time\}\}/g, new Date().toISOString())
    .replace(/\{\{user_name\}\}/g, opts.userName);
}

/** Check for unreplaced template variables */
export function validateRendered(rendered: string): string[] {
  const unreplaced = rendered.match(/\{\{[a-z_]+\}\}/g);
  return unreplaced ? [...new Set(unreplaced)] : [];
}
