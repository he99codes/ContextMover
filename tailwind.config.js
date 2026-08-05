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
          // [CM-GREEN] Original green & black palette restored.
          white:       "#FFFFFF",
          orange:      "#00FF88",
          gold:        "#00D26A",
          "gold-bright":"#00C853",
          pink:        "#A855F7",
          silver:      "#E5E5E5",
          coral:       "#FF4444",
          // legacy token names preserved for compatibility
          light:       "#E5E5E5",
          lightdim:    "#00D26A",
          mid:         "#FF4444",
          green:       "#00FF88",
          "green-dim": "#00D26A",
        },
        // [CM-GREEN] Platform logos in original brand colors.
        platform: {
          claude:     "#D97757",
          chatgpt:    "#10A37F",
          gemini:     "#4285F4",
          grok:       "#1DA1F2",
          perplexity: "#20B848",
          deepseek:   "#4D6BFE",
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
