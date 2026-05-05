"use client";

import { useState, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Zap, Eye, EyeOff, AlertCircle } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

function AuthForm() {
  const searchParams = useSearchParams();
  const [mode, setMode] = useState<"signin" | "signup">(
    searchParams.get("mode") === "signup" ? "signup" : "signin"
  );
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const router = useRouter();

  const handleAuth = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setError(null);
    setSuccess(null);

    const supabase = createClient();

    try {
      if (mode === "signin") {
        const { error } = await supabase.auth.signInWithPassword({
          email,
          password,
        });
        if (error) throw error;
        router.push("/dashboard");
        router.refresh();
      } else {
        const { error } = await supabase.auth.signUp({
          email,
          password,
          options: {
            emailRedirectTo: `${window.location.origin}/auth/callback`,
          },
        });
        if (error) throw error;
        setSuccess(
          "Check your email for a confirmation link to complete sign up."
        );
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "An error occurred");
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-[#0A0A0A] p-4">
      <div className="w-full max-w-[380px]">
        {/* Logo */}
        <div className="mb-8 text-center">
          <div className="mb-3 flex items-center justify-center gap-2">
            <div className="flex h-9 w-9 items-center justify-center rounded-[8px] bg-[#00FF88]">
              <Zap size={18} className="text-black" />
            </div>
            <span className="text-xl font-semibold text-[#F5F5F5]">
              ContextForge
            </span>
          </div>
          <p className="text-sm text-[#6B6B6B]">
            Never lose AI context again
          </p>
        </div>

        <Card className="border-[#2A2A2A] bg-[#111111] shadow-[0_0_40px_rgba(0,0,0,0.6)]">
          <CardHeader className="pb-4">
            <CardTitle className="text-[#F5F5F5]">
              {mode === "signin" ? "Welcome back" : "Create an account"}
            </CardTitle>
            <CardDescription className="text-[#6B6B6B]">
              {mode === "signin"
                ? "Sign in to access your sessions and migrations"
                : "Start capturing and migrating AI context for free"}
            </CardDescription>
          </CardHeader>

          <CardContent>
            <form onSubmit={handleAuth} className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="email" className="text-[#F5F5F5] text-xs uppercase tracking-wider">Email</Label>
                <Input
                  id="email"
                  type="email"
                  placeholder="you@example.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  autoComplete="email"
                  disabled={isLoading}
                  className="bg-[#1A1A1A] border-[#2A2A2A] text-[#F5F5F5] placeholder:text-[#6B6B6B] focus:border-[#00FF88] focus:ring-0 rounded-[8px]"
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="password" className="text-[#F5F5F5] text-xs uppercase tracking-wider">Password</Label>
                <div className="relative">
                  <Input
                    id="password"
                    type={showPassword ? "text" : "password"}
                    placeholder="••••••••"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                    autoComplete={
                      mode === "signin" ? "current-password" : "new-password"
                    }
                    disabled={isLoading}
                    className="bg-[#1A1A1A] border-[#2A2A2A] text-[#F5F5F5] placeholder:text-[#6B6B6B] focus:border-[#00FF88] focus:ring-0 rounded-[8px] pr-9"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((v) => !v)}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[#6B6B6B] hover:text-[#F5F5F5] transition-colors"
                    tabIndex={-1}
                  >
                    {showPassword ? (
                      <EyeOff size={15} />
                    ) : (
                      <Eye size={15} />
                    )}
                  </button>
                </div>
              </div>

              {error && (
                <div className="flex items-start gap-2 rounded-[8px] border border-red-500/30 bg-red-500/10 px-3 py-2.5 text-sm text-red-400">
                  <AlertCircle size={15} className="mt-0.5 shrink-0" />
                  <span>{error}</span>
                </div>
              )}

              {success && (
                <div className="rounded-[8px] border border-[#00FF88]/30 bg-[#00FF88]/10 px-3 py-2.5 text-sm text-[#00FF88]">
                  {success}
                </div>
              )}

              <Button
                type="submit"
                disabled={isLoading}
                className="w-full bg-[#00FF88] hover:bg-[#00CC6A] text-black font-semibold rounded-[8px] transition-all hover:shadow-[0_0_16px_rgba(0,255,136,0.3)]"
              >
                {isLoading
                  ? "Loading…"
                  : mode === "signin"
                  ? "Sign in"
                  : "Create account"}
              </Button>
            </form>

            <div className="mt-4 text-center">
              <button
                type="button"
                onClick={() => {
                  setMode(mode === "signin" ? "signup" : "signin");
                  setError(null);
                  setSuccess(null);
                }}
                className="text-sm text-[#6B6B6B] transition-colors hover:text-[#00FF88]"
              >
                {mode === "signin"
                  ? "Don't have an account? Sign up"
                  : "Already have an account? Sign in"}
              </button>
            </div>
          </CardContent>
        </Card>

        <p className="mt-6 text-center text-xs text-[#6B6B6B]/60">
          By signing in you agree to our{" "}
          <a href="/terms" className="hover:text-[#00FF88] transition-colors">Terms of Service</a>{" "}
          and{" "}
          <a href="/privacy" className="hover:text-[#00FF88] transition-colors">Privacy Policy</a>.
        </p>
      </div>
    </div>
  );
}

export default function AuthPage() {
  return (
    <Suspense fallback={<div className="flex min-h-screen items-center justify-center bg-[#0A0A0A]" />}>
      <AuthForm />
    </Suspense>
  );
}
