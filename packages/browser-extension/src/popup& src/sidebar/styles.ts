export const styles = `
  .contextforge-popup {
    position: fixed;
    bottom: 20px;
    right: 20px;
    width: 350px;
    background: white;
    border-radius: 8px;
    box-shadow: 0 4px 12px rgba(0,0,0,0.15);
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto;
    z-index: 10000;
  }

  .contextforge-popup__header {
    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    color: white;
    padding: 16px;
    border-radius: 8px 8px 0 0;
    font-weight: 600;
  }

  .contextforge-popup__content {
    padding: 16px;
    max-height: 400px;
    overflow-y: auto;
  }
`;
