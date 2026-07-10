/**
 * Copyright © 2026 ContextMover. All rights reserved.
 * Unauthorized copying, modification, distribution, or use
 * of this software, via any medium, is strictly prohibited.
 * Proprietary and confidential.
 */

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
      users: {
        Row: {
          id:              string;
          email:           string | null;
          is_pro:          boolean;
          plan:            string;
          pro_since:       string | null;
          gateway:         string | null;
          subscription_id: string | null;
          payment_id:      string | null;
          created_at:      string;
        };
        Insert: {
          id:              string;
          email?:          string | null;
          is_pro?:         boolean;
          plan?:           string;
          pro_since?:      string | null;
          gateway?:        string | null;
          subscription_id?: string | null;
          payment_id?:     string | null;
          created_at?:     string;
        };
        Update: {
          id?:             string;
          email?:          string | null;
          is_pro?:         boolean;
          plan?:           string;
          pro_since?:      string | null;
          gateway?:        string | null;
          subscription_id?: string | null;
          payment_id?:     string | null;
          created_at?:     string;
        };
      };
      payments: {
        Row: {
          id:         string;
          user_id:    string | null;
          gateway:    string;
          payment_id: string | null;
          order_id:   string | null;
          amount:     number | null;
          currency:   string | null;
          plan:       string | null;
          status:     string | null;
          created_at: string;
        };
        Insert: {
          id?:        string;
          user_id?:   string | null;
          gateway:    string;
          payment_id?: string | null;
          order_id?:  string | null;
          amount?:    number | null;
          currency?:  string | null;
          plan?:      string | null;
          status?:    string | null;
          created_at?: string;
        };
        Update: {
          id?:        string;
          user_id?:   string | null;
          gateway?:   string;
          payment_id?: string | null;
          order_id?:  string | null;
          amount?:    number | null;
          currency?:  string | null;
          plan?:      string | null;
          status?:    string | null;
          created_at?: string;
        };
      };
      usage: {
        Row: {
          id:      string;
          user_id: string;
          feature: string;
          month:   string;
          count:   number;
        };
        Insert: {
          id?:     string;
          user_id: string;
          feature: string;
          month:   string;
          count?:  number;
        };
        Update: {
          id?:     string;
          user_id?: string;
          feature?: string;
          month?:   string;
          count?:   number;
        };
      };
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
