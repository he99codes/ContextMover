export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

export interface Database {
  public: {
    Tables: {
      sessions: {
        Row: {
          id: string;
          user_id: string;
          platform: string;
          title: string | null;
          messages: Json;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id: string;
          user_id: string;
          platform: string;
          title?: string | null;
          messages?: Json;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          user_id?: string;
          platform?: string;
          title?: string | null;
          messages?: Json;
          created_at?: string;
          updated_at?: string;
        };
      };
      migrations: {
        Row: {
          id: string;
          user_id: string;
          session_id: string | null;
          source_platform: string | null;
          target_platform: string | null;
          migrated_at: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          session_id?: string | null;
          source_platform?: string | null;
          target_platform?: string | null;
          migrated_at?: string;
        };
        Update: {
          id?: string;
          user_id?: string;
          session_id?: string | null;
          source_platform?: string | null;
          target_platform?: string | null;
          migrated_at?: string;
        };
      };
      custom_agents: {
        Row: {
          id: string;
          user_id: string;
          name: string;
          url: string;
          input_selector: string | null;
          message_selector: string | null;
          role_detection: string | null;
          output_format: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          name: string;
          url: string;
          input_selector?: string | null;
          message_selector?: string | null;
          role_detection?: string | null;
          output_format?: string | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          user_id?: string;
          name?: string;
          url?: string;
          input_selector?: string | null;
          message_selector?: string | null;
          role_detection?: string | null;
          output_format?: string | null;
          created_at?: string;
        };
      };
    };
  };
}
