const fs = require('fs');

const path = 'packages/web/src/types/database.ts';
let content = fs.readFileSync(path, 'utf8');

const newTypes = `
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
`;

content = content.replace('    Tables: {', '    Tables: {' + newTypes);

// Also add fields to users
content = content.replace(
  '          created_at:      string;\n        };',
  '          created_at:      string;\n          razorpay_subscription_id?: string | null;\n          subscription_status?: string | null;\n        };'
);
content = content.replace(
  '          created_at?:     string;\n        };',
  '          created_at?:     string;\n          razorpay_subscription_id?: string | null;\n          subscription_status?: string | null;\n        };'
);
// replace last occurrence for Update
content = content.replace(
  '          created_at?:     string;\n        };\n      };\n      payments',
  '          created_at?:     string;\n          razorpay_subscription_id?: string | null;\n          subscription_status?: string | null;\n        };\n      };\n      payments'
);


fs.writeFileSync(path, content);
