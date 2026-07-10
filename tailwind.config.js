export default {
  content: ["./src/**/*.{ts,tsx,html}"],
  theme: {
    extend: {
      colors: {
        cf: {
          bg:          "#0A0A0A",
          surface:     "#111111",
          card:        "#1A1A1A",
          border:      "#2A2A2A",
          text:        "#F5F5F5",
          muted:       "#6B6B6B",
          green:       "#00FF88",
          "green-dim": "#00CC6A",
        },
        platform: {
          claude:     "#D97706",
          chatgpt:    "#10B981",
          gemini:     "#6366F1",
          grok:       "#F5F5F5",
          perplexity: "#20B2AA",
          deepseek:   "#4C8BF5",
        },
      },
      borderRadius: {
        sm:   "4px",
        card: "8px",
      },
      fontFamily: {
        sans: ["Inter", "system-ui", "-apple-system", "sans-serif"],
      },
    },
  },
  plugins: [],
};
