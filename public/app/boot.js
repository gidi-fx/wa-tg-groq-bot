    /* =============================== router =============================== */
    const pages = {
      '/': dashboardPage,
      '/connect': connectPage,
      '/agents': agentsPage,
      '/inbox': inboxPage,
      '/groups': groupsPage,
      '/playground': playgroundPage,
      '/settings': settingsPage,
      '/telegram': telegramPage,
    };

    async function render() {
      const path = (location.pathname.replace(/\/+$/, '') || '/');
      const [title, subtitle] = titles[path] || ['Not found', ''];
      $('#page-title').textContent = title;
      $('#page-subtitle').textContent = subtitle;
      document.title = title + ' · WhatsApp Groq Router v2';
      setActiveNav(path);
      paintPersistenceBanner();

      if (typeof state.cleanup === 'function') {
        try { state.cleanup(); } catch { /* ignore */ }
        state.cleanup = null;
      }

      const view = $('#view');
      view.innerHTML = spinner('Loading');
      const page = pages[path] || notFoundPage;
      try {
        const cleanup = await page(view);
        if (typeof cleanup === 'function') state.cleanup = cleanup;
      } catch (error) {
        view.innerHTML = errorBox(error);
        const retry = $('#retry-btn', view);
        if (retry) retry.addEventListener('click', render);
      }
      paintPersistenceBanner();
      window.scrollTo({ top: 0, behavior: 'instant' });
    }

    window.addEventListener('popstate', render);

    $('#sidebar-nav').innerHTML = navHTML(false);
    $('#mobile-nav').innerHTML = navHTML(true);
    setTheme(document.documentElement.classList.contains('dark'));
    render();
