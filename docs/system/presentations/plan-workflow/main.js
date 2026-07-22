(function () {
  const navLinks = document.querySelectorAll(".nav-list a[data-section]");
  const sections = document.querySelectorAll("[data-section-id]");
  const sidebar = document.getElementById("sidebar");
  const navToggle = document.getElementById("navToggle");
  const presentBtn = document.getElementById("presentBtn");
  const lightbox = document.getElementById("lightbox");
  const lightboxImg = document.getElementById("lightboxImg");
  const lightboxClose = document.getElementById("lightboxClose");

  function setActiveNav(id) {
    navLinks.forEach((link) => {
      link.classList.toggle("active", link.dataset.section === id);
    });
  }

  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          setActiveNav(entry.target.dataset.sectionId);
        }
      });
    },
    { rootMargin: "-30% 0px -55% 0px", threshold: 0 }
  );

  sections.forEach((section) => observer.observe(section));

  navLinks.forEach((link) => {
    link.addEventListener("click", () => {
      sidebar.classList.remove("open");
    });
  });

  if (navToggle) {
    navToggle.addEventListener("click", () => {
      sidebar.classList.toggle("open");
    });
  }

  document.querySelectorAll(".figure img, .split .figure img").forEach((img) => {
    img.addEventListener("click", () => {
      lightboxImg.src = img.src;
      lightboxImg.alt = img.alt;
      lightbox.classList.add("open");
      document.body.style.overflow = "hidden";
    });
  });

  function closeLightbox() {
    lightbox.classList.remove("open");
    document.body.style.overflow = "";
  }

  lightbox.addEventListener("click", closeLightbox);
  lightboxClose.addEventListener("click", (e) => {
    e.stopPropagation();
    closeLightbox();
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      closeLightbox();
      if (document.body.classList.contains("present-mode")) {
        document.body.classList.remove("present-mode");
        presentBtn.textContent = "专注阅读";
      }
    }
  });

  if (presentBtn) {
    presentBtn.addEventListener("click", () => {
      const on = document.body.classList.toggle("present-mode");
        presentBtn.textContent = on ? "退出专注" : "专注阅读";
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
  }
})();
