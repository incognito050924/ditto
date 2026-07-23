(function () {
  "use strict";

  const navToggle = document.querySelector(".nav-toggle");
  const navStatus = document.querySelector(".nav-status");
  const jumpPanel = document.querySelector("#jumpPanel");
  const jumpList = document.querySelector(".jump-panel__list");
  const jumpClose = document.querySelector(".jump-panel__close");

  Reveal.initialize({
    width: 1280,
    height: 720,
    margin: 0,
    minScale: 0.2,
    maxScale: 2,
    center: false,
    hash: true,
    controls: true,
    progress: true,
    slideNumber: false,
    transition: "fade",
    transitionSpeed: "fast",
    fragments: true,
  });

  function slides() {
    return Reveal.getHorizontalSlides();
  }

  function goTo(index) {
    Reveal.slide(index, 0, 0);
    closePanel();
  }

  function openPanel() {
    jumpPanel.hidden = false;
    navToggle.setAttribute("aria-expanded", "true");
  }

  function closePanel() {
    jumpPanel.hidden = true;
    navToggle.setAttribute("aria-expanded", "false");
  }

  function togglePanel() {
    if (jumpPanel.hidden) openPanel();
    else closePanel();
  }

  function renderJumpList() {
    jumpList.replaceChildren();
    slides().forEach((slide, index) => {
      const button = document.createElement("button");
      const section = slide.dataset.section || "";
      const title = slide.dataset.title || `Slide ${index + 1}`;
      button.type = "button";
      button.dataset.jump = String(index);
      button.innerHTML = `<span>${String(index + 1).padStart(2, "0")}</span><b>${title}</b><small>${section}</small>`;
      jumpList.appendChild(button);
    });
  }

  function updateStatus() {
    const total = slides().length;
    const current = Reveal.getIndices().h + 1;
    const slide = slides()[current - 1];
    const title = slide ? slide.dataset.title || "" : "";
    navStatus.textContent = `${String(current).padStart(2, "0")} / ${String(total).padStart(2, "0")} · ${title}`;

    jumpList.querySelectorAll("button").forEach((button) => {
      button.classList.toggle("is-current", Number(button.dataset.jump) === current - 1);
    });
  }

  document.addEventListener("click", (event) => {
    const jump = event.target.closest("[data-jump]");
    if (jump) {
      goTo(Number(jump.dataset.jump));
      return;
    }

    if (!jumpPanel.hidden && !event.target.closest(".jump-panel") && !event.target.closest(".nav-toggle")) {
      closePanel();
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closePanel();
    if (event.key.toLowerCase() === "m") togglePanel();
  });

  navToggle.addEventListener("click", togglePanel);
  jumpClose.addEventListener("click", closePanel);
  Reveal.on("ready", () => {
    renderJumpList();
    updateStatus();
  });
  Reveal.on("slidechanged", updateStatus);
})();
