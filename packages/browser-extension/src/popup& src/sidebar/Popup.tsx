export const Popup = () => {
    return `
    <div class="contextforge-popup">
      <div class="contextforge-popup__header">
        <h2>ContextForge</h2>
      </div>
      <div class="contextforge-popup__content">
        <p>Ready to enhance your AI experience</p>
      </div>
    </div>
  `;
};

export const renderPopup = (container: HTMLElement) => {
    container.innerHTML = Popup();
};
