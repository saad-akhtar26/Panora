import { ApiPropertyOptional } from '@nestjs/swagger';

export class UnifiedCommentInput {
  body: string;
  html_body?: string;
  is_private?: boolean;
  created_at: Date;
  modified_at: Date;
  creator_type: 'user' | 'contact' | null;
  ticket_id: string;
  contact_id?: string;
  user_id?: string;
}

//TODO: add remote_id
export class UnifiedCommentOutput extends UnifiedCommentInput {
  id: string;
}
