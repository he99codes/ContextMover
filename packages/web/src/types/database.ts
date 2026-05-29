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
      subscriptions: {
        Row: {
          id: string;
          user_id: string;
          razorpay_subscription_id: string;
          razorpay_plan_id: string;
          plan: 'monthly' | 'annual';
          status: 'created' | 'authenticated' | 'active' | 'paused' | 'cancelled' | 'completed' | 'expired';
          current_start: string | null;
          current_end: string | null;
          ended_at: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          user_id: string;
          razorpay_subscription_id: string;
          razorpay_plan_id: string;
          plan: 'monthly' | 'annual';
          status?: 'created' | 'authenticated' | 'active' | 'paused' | 'cancelled' | 'completed' | 'expired';
          current_start?: string | null;
          current_end?: string | null;
          ended_at?: string | null;
        };
        Update: {
          user_id?: string;
          razorpay_subscription_id?: string;
          razorpay_plan_id?: string;
          plan?: 'monthly' | 'annual';
          status?: 'created' | 'authenticated' | 'active' | 'paused' | 'cancelled' | 'completed' | 'expired';
          current_start?: string | null;
          current_end?: string | null;
          ended_at?: string | null;
          updated_at?: string;
        };
      };
      payment_events: {
        Row: {
          id: string;
          razorpay_event_id: string;
          event_type: string;
          razorpay_subscription_id: string | null;
          razorpay_payment_id: string | null;
          payload: Json | null;
          processed_at: string;
        };
        Insert: {
          razorpay_event_id: string;
          event_type: string;
          razorpay_subscription_id?: string | null;
          razorpay_payment_id?: string | null;
          payload?: Json | null;
        };
        Update: {
          razorpay_event_id?: string;
          event_type?: string;
          razorpay_subscription_id?: string | null;
          razorpay_payment_id?: string | null;
          payload?: Json | null;
        };
      };

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
          razorpay_subscription_id?: string | null;
          subscription_status?: string | null;
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
          razorpay_subscription_id?: string | null;
          subscription_status?: string | null;
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
          razorpay_subscription_id?: string | null;
          subscription_status?: string | null;
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
