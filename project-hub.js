import {
      supabase,
      isSupabaseConfigured,
      currentUser,
      authHeaders,
      signInWithGoogle,
      signInWithPassword,
      signUpWithPassword,
      signOut,
      isEmbeddedPreview
    } from './supabase-client.js?v=20260727';

    const $ = selector => document.querySelector(selector);
    const $$ = selector => [...document.querySelectorAll(selector)];
    const escapeHtml = value => String(value ?? '').replace(
      /[&<>"']/g,
      char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]
    );
    const normalizeTags = value => String(value || '')
      .split(',')
      .map(tag => tag.trim().toLowerCase().replace(/[^a-z0-9 +#.-]/g, ''))
      .filter(Boolean)
      .slice(0, 8);
    const PROJECT_IMAGE_PREFIX = '__image__:';
    const PROJECT_LOCATION_PREFIX = '__location__:';
    const APPLICATIONS_PAUSED_TAG = '__applications_paused__';
    const projectTags = project => (project?.tags || [])
      .filter(tag =>
        !String(tag).startsWith(PROJECT_IMAGE_PREFIX) &&
        !String(tag).startsWith(PROJECT_LOCATION_PREFIX) &&
        String(tag) !== APPLICATIONS_PAUSED_TAG
      );
    const isAcceptingApplications = project =>
      project?.status === 'open' &&
      !(project?.tags || []).includes(APPLICATIONS_PAUSED_TAG);
    const projectImageData = project => {
      const marker = (project?.tags || []).find(tag => String(tag).startsWith(PROJECT_IMAGE_PREFIX));
      return marker ? String(marker).slice(PROJECT_IMAGE_PREFIX.length) : '';
    };
    // profiles.location_* columns are the single source of truth for a
    // member's shared location. An earlier version also mirrored this into
    // auth user_metadata and into a hidden tag on every owned project —
    // three copies that could (and did) drift out of sync on a partial
    // failure. Reading straight from the loaded profile row here removes
    // that whole class of bug.
    const profileLocation = profileRow => {
      // Number.isFinite (no coercion) on purpose: Number(null) is 0, a
      // real-looking coordinate, so a coerced check would treat "no
      // location saved" as "shared at 0°,0°".
      const latitude = profileRow?.location_latitude;
      const longitude = profileRow?.location_longitude;
      if (
        !Number.isFinite(latitude) ||
        !Number.isFinite(longitude) ||
        latitude < -90 || latitude > 90 ||
        longitude < -180 || longitude > 180
      ) return null;
      return {
        shared: true,
        label: String(profileRow?.location_label || '').trim().slice(0, 100),
        latitude,
        longitude
      };
    };
    const fileToDataUrl = file => new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => reject(new Error('The selected image could not be read.'));
      reader.readAsDataURL(file);
    });
    const canvasToBlob = (canvas, type, quality) => new Promise(resolve => canvas.toBlob(resolve, type, quality));

    async function optimizeImage(file, { maxWidth, maxHeight, byteLimit, hardLimit }) {
      if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
        throw new Error('Choose a JPEG, PNG, or WebP image.');
      }
      if (file.size > 8 * 1024 * 1024) throw new Error('Images must be 8 MB or smaller.');
      const bitmap = await createImageBitmap(file);
      const baseScale = Math.min(1, maxWidth / bitmap.width, maxHeight / bitmap.height);
      const canvas = document.createElement('canvas');
      const context = canvas.getContext('2d', { alpha: false });
      let smallest = null;
      for (const dimensionScale of [1, .82, .68]) {
        canvas.width = Math.max(1, Math.round(bitmap.width * baseScale * dimensionScale));
        canvas.height = Math.max(1, Math.round(bitmap.height * baseScale * dimensionScale));
        context.fillStyle = '#171717';
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        for (const quality of [.82, .68, .54]) {
          const blob = await canvasToBlob(canvas, 'image/webp', quality)
            || await canvasToBlob(canvas, 'image/jpeg', quality);
          if (!blob) continue;
          smallest = !smallest || blob.size < smallest.size ? blob : smallest;
          if (blob.size <= byteLimit) {
            bitmap.close?.();
            return await fileToDataUrl(blob);
          }
        }
      }
      bitmap.close?.();
      if (smallest && smallest.size <= hardLimit) {
        return await fileToDataUrl(smallest);
      }
      throw new Error('This image could not be optimized enough. Try a simpler or smaller image.');
    }

    async function optimizeProjectImage(file) {
      const dataUrl = await optimizeImage(file, {
        maxWidth: 1440,
        maxHeight: 960,
        byteLimit: 180 * 1024,
        hardLimit: 260 * 1024
      });
      return `${PROJECT_IMAGE_PREFIX}${dataUrl}`;
    }

    async function optimizeAvatarImage(file) {
      return optimizeImage(file, {
        maxWidth: 320,
        maxHeight: 320,
        byteLimit: 60 * 1024,
        hardLimit: 100 * 1024
      });
    }

    async function optimizeBannerImage(file) {
      return optimizeImage(file, {
        maxWidth: 1200,
        maxHeight: 360,
        byteLimit: 150 * 1024,
        hardLimit: 220 * 1024
      });
    }

    const previewProjects = [
      { id: 'preview-1', title: 'Mindweave', summary: 'A voice-first journal for people who do not enjoy journaling.', description: 'Preview example for the disconnected board.', tags: ['engineering', 'design'], status: 'open', owner: 'Preview project' },
      { id: 'preview-2', title: 'Nestmate', summary: 'A local support network designed around new parenthood.', description: 'Preview example for the disconnected board.', tags: ['design', 'research'], status: 'open', owner: 'Preview project' },
      { id: 'preview-3', title: 'Pulseboard', summary: 'A focused status page for independent product teams.', description: 'Preview example for the disconnected board.', tags: ['engineering'], status: 'open', owner: 'Preview project' }
    ];

    let user = null;
    let profile = null;
    let projects = [];
    let ownedProjects = [];
    let applications = [];
    let sentApplications = [];
    let interviews = [];
    let projectReviews = [];
    let reviewsAvailable = false;
    let activeProject = null;
    let activeFilter = 'all';
    let editingProjectId = null;
    let editingQuestionId = null;
    let loadError = '';
    let requestSubscription = null;
    let requestSubscriptionUserId = null;
    const savedProjectsKey = 'connected:saved-projects';
    let savedProjectIds = new Set();
    try {
      const storedSavedProjects = JSON.parse(localStorage.getItem(savedProjectsKey) || '[]');
      if (Array.isArray(storedSavedProjects)) {
        savedProjectIds = new Set(storedSavedProjects.map(String));
      }
    } catch (_) {
      savedProjectIds = new Set();
    }

    function toast(message) {
      const element = $('#toast');
      element.textContent = message;
      element.classList.add('show');
      window.clearTimeout(toast.timer);
      toast.timer = window.setTimeout(() => element.classList.remove('show'), 3400);
    }

    function statusLabel(status) {
      return ({
        pending: 'Pending',
        accepted: 'Accepted',
        declined: 'Declined',
        interview: 'Interview'
      })[status] || 'Updated';
    }

    function formatDate(value) {
      if (!value) return '';
      return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
        .format(new Date(value));
    }

    function reviewSummary(profileId) {
      const received = projectReviews.filter(review => String(review.reviewee_id) === String(profileId));
      const average = received.length
        ? received.reduce((sum, review) => sum + Number(review.rating || 0), 0) / received.length
        : 0;
      return { received, average };
    }

    function starText(rating) {
      const rounded = Math.max(0, Math.min(5, Math.round(Number(rating) || 0)));
      return '★'.repeat(rounded) + '☆'.repeat(5 - rounded);
    }

    // profile.avatar_url is the source of truth once a member uploads their
    // own photo (custom_avatar); provider metadata is only a fallback for
    // before that first sync/upload happens.
    function currentAvatarUrl() {
      return String(
        profile?.avatar_url ||
        user?.user_metadata?.avatar_url ||
        user?.user_metadata?.picture ||
        ''
      ).trim();
    }

    function requestSeenKey() {
      return user ? `connected:request-updates-seen:${user.id}` : '';
    }

    function requestUpdates() {
      const seenAt = Number(localStorage.getItem(requestSeenKey()) || 0);
      return sentApplications.filter(application =>
        application.status !== 'pending' &&
        new Date(application.updated_at || application.created_at).getTime() > seenAt
      );
    }

    function subscribeToRequestUpdates() {
      if (!supabase || !user) {
        if (requestSubscription) supabase?.removeChannel(requestSubscription);
        requestSubscription = null;
        requestSubscriptionUserId = null;
        return;
      }
      if (requestSubscription && requestSubscriptionUserId === user.id) return;
      if (requestSubscription) supabase.removeChannel(requestSubscription);
      requestSubscriptionUserId = user.id;
      requestSubscription = supabase
        .channel(`request-updates-${user.id}`)
        .on('postgres_changes', {
          event: 'UPDATE',
          schema: 'public',
          table: 'applications',
          filter: `applicant_id=eq.${user.id}`
        }, payload => {
          const title = sentApplications.find(item => item.id === payload.new.id)?.projects?.title || 'a project';
          toast(`Your request for ${title} is now ${statusLabel(payload.new.status).toLowerCase()}.`);
          window.setTimeout(loadAll, 0);
        })
        .subscribe();
    }

    async function pollRequestStatuses() {
      if (!supabase || !user || document.hidden) return;
      const result = await supabase
        .from('applications')
        .select('id,project_id,applicant_id,message,status,created_at,updated_at,projects(id,title,owner_id,profiles:owner_id(display_name))')
        .eq('applicant_id', user.id)
        .order('created_at', { ascending: false });
      if (result.error) return;
      const next = result.data || [];
      const previous = new Map(sentApplications.map(item => [item.id, item.status]));
      const changed = next.find(item => previous.has(item.id) && previous.get(item.id) !== item.status);
      sentApplications = next;
      $('#request-count').textContent = sentApplications.length;
      renderRequests();
      renderNotifications();
      if (changed) {
        toast(`Your request for ${changed.projects?.title || 'a project'} is now ${statusLabel(changed.status).toLowerCase()}.`);
      }
    }

    let activeModal = null;
    let modalReturnFocus = null;
    const modalBackground = [document.querySelector('header'), document.querySelector('main'), $('#preview-note')].filter(Boolean);
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    function openModal(name) {
      const modal = $(`#modal-${name}`);
      window.clearTimeout(modal.closeTimer);
      modal.classList.remove('closing');
      modalReturnFocus = document.activeElement;
      activeModal = modal;
      modal.classList.add('open');
      modal.setAttribute('aria-hidden', 'false');
      modalBackground.forEach(region => region.inert = true);
      document.body.classList.add('modal-open');
      window.requestAnimationFrame(() => {
        const target = modal.querySelector('input:not([disabled]), textarea:not([disabled]), select:not([disabled]), button:not([disabled])');
        (target || modal).focus();
      });
    }

    function closeModal(name) {
      const modal = $(`#modal-${name}`);
      if (!modal.classList.contains('open')) return;
      const returnTarget = modalReturnFocus;
      const finish = () => {
        modal.classList.remove('open', 'closing');
        modal.setAttribute('aria-hidden', 'true');
        modalBackground.forEach(region => region.inert = false);
        document.body.classList.remove('modal-open');
        if (activeModal === modal) activeModal = null;
        if (returnTarget && document.contains(returnTarget)) returnTarget.focus();
        modalReturnFocus = null;
      };
      if (reducedMotion) {
        finish();
        return;
      }
      modal.classList.add('closing');
      modal.closeTimer = window.setTimeout(finish, 170);
    }

    document.addEventListener('keydown', event => {
      if (!activeModal) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        closeModal(activeModal.id.replace('modal-', ''));
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = [...activeModal.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])')]
        .filter(element => !element.hidden && element.offsetParent !== null);
      if (!focusable.length) {
        event.preventDefault();
        activeModal.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    });

    async function beginGoogleSignIn(button = null) {
      const originalLabel = button?.textContent;
      if (button) {
        button.disabled = true;
        button.textContent = 'Connecting…';
      }
      try {
        const result = await signInWithGoogle('/project-hub.html');
        if (result.previewHandoff) {
          toast('Google needs a full browser tab, so sign-in continues on the live site. In this preview, use email and password instead.');
        }
      } catch (error) {
        toast(error.message || 'Google sign-in is unavailable.');
      } finally {
        if (button) {
          button.disabled = false;
          button.textContent = originalLabel;
        }
      }
    }

    async function storeGoogleRefreshToken(refreshToken) {
      try {
        await fetch('/api/store-google-token', {
          method: 'POST',
          headers: await authHeaders(),
          body: JSON.stringify({ refreshToken })
        });
      } catch (_) {
        // Best-effort — if this fails, scheduling an interview later will
        // surface a clear "reconnect Google" prompt instead of failing silently.
      }
    }

    let authMode = 'signin';
    function setAuthMode(mode) {
      authMode = mode;
      const signup = mode === 'signup';
      $('#name-field').hidden = !signup;
      $('#auth-title').textContent = signup ? 'Create your account' : 'Sign in to continue';
      $('#email-auth').textContent = signup ? 'Create account' : 'Sign in';
      $('#auth-mode').textContent = signup
        ? 'Already have an account? Sign in'
        : 'New here? Create an account';
      $('#auth-form [name=password]').autocomplete = signup ? 'new-password' : 'current-password';
    }
    function openAuthModal() {
      $('#auth-preview-note').hidden = !isEmbeddedPreview();
      openModal('auth');
    }
    $('#auth-form').onsubmit = async event => {
      event.preventDefault();
      const form = event.currentTarget;
      const submit = $('#email-auth');
      const originalLabel = submit.textContent;
      form.setAttribute('aria-busy', 'true');
      submit.disabled = true;
      submit.textContent = authMode === 'signup' ? 'Creating…' : 'Signing in…';
      const values = new FormData(form);
      try {
        const result = authMode === 'signup'
          ? await signUpWithPassword(
              String(values.get('email')).trim(),
              String(values.get('password')),
              String(values.get('name')).trim()
            )
          : await signInWithPassword(
              String(values.get('email')).trim(),
              String(values.get('password'))
            );
        if (result.error) throw result.error;
        closeModal('auth');
        toast(authMode === 'signup' ? 'Check your email to confirm your account.' : 'Signed in.');
        await loadAll();
      } catch (error) {
        toast(error.message);
      } finally {
        form.setAttribute('aria-busy', 'false');
        submit.disabled = false;
        submit.textContent = originalLabel;
      }
    };
    $('#google-auth').onclick = event => beginGoogleSignIn(event.currentTarget);
    $('#auth-mode').onclick = () => setAuthMode(authMode === 'signin' ? 'signup' : 'signin');

    async function requireUser() {
      if (user) return user;
      toast('Sign in to continue.');
      openAuthModal();
      return null;
    }

    async function loadAll() {
      const discoveryBoard = $('#discovery-board');
      loadError = '';
      discoveryBoard.setAttribute('aria-busy', 'true');
      discoveryBoard.innerHTML = '<span class="sr-only">Loading projects</span><div class="skeleton" aria-hidden="true"></div><div class="skeleton" aria-hidden="true"></div><div class="skeleton" aria-hidden="true"></div>';
      user = await currentUser();
      await updateAccount();
      if (!isSupabaseConfigured) {
        projects = previewProjects;
        ownedProjects = [];
        applications = [];
        sentApplications = [];
        interviews = [];
        projectReviews = [];
        reviewsAvailable = false;
        $('#preview-note').hidden = false;
        renderAll();
        discoveryBoard.setAttribute('aria-busy', 'false');
        return;
      }

      const projectResult = await supabase
        .from('projects')
        .select('id,title,summary,description,tags,status,seats_total,boost_until,owner_id,created_at,profiles:owner_id(display_name)')
        .order('boost_until', { ascending: false, nullsFirst: false })
        .order('created_at', { ascending: false });

      if (projectResult.error) {
        projects = [];
        ownedProjects = [];
        applications = [];
        sentApplications = [];
        interviews = [];
        projectReviews = [];
        reviewsAvailable = false;
        loadError = projectResult.error.message || 'The project board could not be loaded.';
        renderAll();
        discoveryBoard.setAttribute('aria-busy', 'false');
        toast('The project board could not be loaded.');
        return;
      }

      projects = (projectResult.data || []).map(project => ({
        ...project,
        owner: project.profiles?.display_name || 'connectEd member'
      }));
      ownedProjects = user ? projects.filter(project => project.owner_id === user.id) : [];

      if (user) {
        let profileResult = await supabase
          .from('profiles')
          .select('id,display_name,headline,bio,skills,avatar_url,banner_url,custom_avatar,priority_match_active')
          .eq('id', user.id)
          .maybeSingle();
        if (profileResult.error && /permission denied/i.test(profileResult.error.message)) {
          profileResult = await supabase
            .from('profiles')
            .select('id,display_name,headline,bio,skills,avatar_url,priority_match_active')
            .eq('id', user.id)
            .maybeSingle();
        }
        profile = profileResult.data || null;

        // Only sync the provider's photo in when the member hasn't chosen
        // their own — otherwise every reload would clobber a custom upload.
        const providerAvatar = String(user.user_metadata?.avatar_url || user.user_metadata?.picture || '').trim();
        if (providerAvatar && !profile?.custom_avatar && profile?.avatar_url !== providerAvatar) {
          const avatarResult = await supabase
            .from('profiles')
            .update({ avatar_url: providerAvatar })
            .eq('id', user.id)
            .select('avatar_url')
            .maybeSingle();
          if (!avatarResult.error && avatarResult.data) {
            profile = { ...profile, avatar_url: avatarResult.data.avatar_url };
          }
        }

        const applicationResult = await supabase
          .from('applications')
          .select('id,project_id,applicant_id,message,answers,status,created_at,updated_at,projects!inner(id,title,owner_id),profiles:applicant_id(id,display_name,headline,bio,skills,avatar_url,priority_match_active)')
          .eq('projects.owner_id', user.id)
          .order('created_at', { ascending: false });
        applications = applicationResult.error ? [] : applicationResult.data || [];

        const sentApplicationResult = await supabase
          .from('applications')
          .select('id,project_id,applicant_id,message,status,created_at,updated_at,projects(id,title,owner_id,profiles:owner_id(display_name))')
          .eq('applicant_id', user.id)
          .order('created_at', { ascending: false });
        sentApplications = sentApplicationResult.error ? [] : sentApplicationResult.data || [];

        let interviewResult = await supabase
          .from('interviews')
          .select('id,application_id,project_id,organizer_id,candidate_id,starts_at,ends_at,title,notes,google_event_id,meet_url,calendar_html_link,created_at')
          .order('starts_at', { ascending: true });
        if (interviewResult.error && /permission denied/i.test(interviewResult.error.message)) {
          // calendar_html_link migration not applied yet — fall back so the
          // rest of the interview data (Meet links, schedule) still loads.
          interviewResult = await supabase
            .from('interviews')
            .select('id,application_id,project_id,organizer_id,candidate_id,starts_at,ends_at,title,notes,google_event_id,meet_url,created_at')
            .order('starts_at', { ascending: true });
        }
        interviews = interviewResult.error ? [] : interviewResult.data || [];

        await updateAccount();
        subscribeToRequestUpdates();
      } else {
        profile = null;
        applications = [];
        sentApplications = [];
        interviews = [];
        subscribeToRequestUpdates();
      }

      // Reviews are publicly readable (reputation is meant to be visible to
      // anyone browsing, signed in or not) so this fetch must not be gated
      // behind `if (user)` — otherwise every profile looks review-less to
      // signed-out visitors even when real reviews exist.
      const reviewResult = await supabase
        .from('project_reviews')
        .select('id,project_id,reviewer_id,reviewee_id,rating,comment,created_at,updated_at,reviewer:reviewer_id(display_name),projects:project_id(title)')
        .order('created_at', { ascending: false });
      reviewsAvailable = !reviewResult.error;
      projectReviews = reviewResult.error ? [] : reviewResult.data || [];

      renderAll();
      discoveryBoard.setAttribute('aria-busy', 'false');
    }

    async function updateAccount() {
      const button = $('#account-action');
      const label = $('#account-label');
      const photo = $('#account-photo');
      if (user) {
        label.textContent = 'Sign out';
        const avatarUrl = currentAvatarUrl();
        photo.referrerPolicy = 'no-referrer';
        photo.onerror = () => { photo.hidden = true; };
        photo.hidden = !avatarUrl;
        if (avatarUrl) photo.src = avatarUrl;
        photo.alt = avatarUrl ? `${user.user_metadata?.full_name || profile?.display_name || 'Account'} profile photo` : '';
        button.onclick = async () => {
          await signOut();
          user = null;
          await loadAll();
          toast('Signed out.');
        };
      } else {
        label.textContent = 'Sign in';
        photo.hidden = true;
        photo.removeAttribute('src');
        photo.alt = '';
        button.onclick = () => openAuthModal();
      }
    }

    function renderAll() {
      const liveProjects = projects.filter(project => project.status !== 'closed');
      $('#board-status').textContent = loadError
        ? 'Board unavailable'
        : isSupabaseConfigured
        ? `${liveProjects.length} open ${liveProjects.length === 1 ? 'project' : 'projects'}`
        : 'Preview board';
      $('#board-status').classList.toggle('is-live', !loadError && isSupabaseConfigured);
      $('#owned-count').textContent = ownedProjects.length;
      $('#request-count').textContent = sentApplications.length;
      $('#applicant-count').textContent = applications.filter(item => item.status === 'pending').length;
      renderProjectFilters();
      $('#saved-count').textContent = savedProjectIds.size;
      renderDiscovery();
      renderOwned();
      renderRequests();
      renderApplicants();
      renderProfile();
      renderNotifications();
      renderLocationNudge();
      // Global, not per-panel: every panel above can render a clickable
      // avatar or name, so bind them once after everything has painted
      // instead of repeating this call in each render function.
      bindProfileViewButtons();
    }

    // Invite signed-in members without a shared location to pin themselves
    // on the Earth view; one dismissal silences it on both pages.
    function renderLocationNudge() {
      const nudge = $('#location-nudge');
      if (!nudge) return;
      let dismissed = false;
      try {
        dismissed = Boolean(user) && localStorage.getItem(`connected:location-invite:${user.id}`) === 'dismissed';
      } catch (_) {}
      nudge.hidden = !user || !isSupabaseConfigured || dismissed || Boolean(profileLocation(profile));
    }
    $('#location-nudge-share').onclick = event => shareLocationInline(event.currentTarget);
    $('#location-nudge-dismiss').onclick = () => {
      if (user) {
        try { localStorage.setItem(`connected:location-invite:${user.id}`, 'dismissed'); } catch (_) {}
      }
      $('#location-nudge').hidden = true;
    };

    // Inline "pin yourself" from the board, mirroring the landing page's
    // one-tap flow — no detour through the profile tab.
    function shareLocationInline(button) {
      if (!navigator.geolocation) return toast('Location is not supported by this browser.');
      button.disabled = true;
      button.textContent = 'Locating…';
      const restore = () => {
        button.disabled = false;
        button.textContent = 'Share location';
      };
      navigator.geolocation.getCurrentPosition(async position => {
        const latitude = Number(position.coords.latitude.toFixed(2));
        const longitude = Number(position.coords.longitude.toFixed(2));
        try {
          const profileResult = await supabase.from('profiles')
            .update({ location_label: null, location_latitude: latitude, location_longitude: longitude })
            .eq('id', user.id);
          if (profileResult.error) throw profileResult.error;
          toast('Pinned on the Earth view.');
          await loadAll();
        } catch (error) {
          toast(error.message || 'Location could not be saved.');
          restore();
        }
      }, error => {
        toast(error.code === 1 ? 'Location permission was not granted.' : 'Your location could not be determined.');
        restore();
      }, { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 });
    }

    function renderProjectFilters() {
      const counts = new Map();
      projects
        .filter(project => project.status !== 'closed')
        .forEach(project => {
          new Set(projectTags(project)).forEach(tag => {
            counts.set(tag, (counts.get(tag) || 0) + 1);
          });
        });
      // Most-used tags first, capped so one-off tags don't crowd the row;
      // short tags read as acronyms (AI, CAD), longer ones as words.
      const tags = [...counts]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([tag]) => tag)
        .slice(0, 8);
      const filterLabel = tag => tag.length <= 3
        ? tag.toUpperCase()
        : tag.charAt(0).toUpperCase() + tag.slice(1);
      if (!['all', 'saved'].includes(activeFilter) && !tags.includes(activeFilter)) activeFilter = 'all';
      $('#hub-project-filters').innerHTML = [
        `<button class="chip${activeFilter === 'all' ? ' active' : ''}" data-filter="all" aria-pressed="${activeFilter === 'all'}">All</button>`,
        ...tags.map(tag => `
          <button class="chip${activeFilter === tag ? ' active' : ''}" data-filter="${escapeHtml(tag)}" aria-pressed="${activeFilter === tag}">
            ${escapeHtml(filterLabel(tag))}
          </button>
        `),
        `<button class="chip${activeFilter === 'saved' ? ' active' : ''}" data-filter="saved" aria-pressed="${activeFilter === 'saved'}">
          Saved <span class="saved-count" id="saved-count">${savedProjectIds.size}</span>
        </button>`
      ].join('');
      $$('[data-filter]').forEach(button => {
        button.onclick = () => {
          activeFilter = button.dataset.filter;
          renderProjectFilters();
          renderDiscovery();
        };
      });
    }

    function filteredProjects() {
      const query = $('#board-search').value.toLowerCase().trim();
      return projects.filter(project => {
        const filterMatch = activeFilter === 'all'
          || (activeFilter === 'saved' && savedProjectIds.has(String(project.id)))
          || projectTags(project).includes(activeFilter);
        const text = [
          project.title, project.summary, project.description, project.owner, ...projectTags(project)
        ].join(' ').toLowerCase();
        return project.status !== 'closed' && filterMatch && (!query || text.includes(query));
      });
    }

    function projectCover(project) {
      const tags = projectTags(project).map(tag => String(tag).toLowerCase());
      if (tags.includes('education')) return 'assets/project-cover-education.png';
      if (tags.includes('community')) return 'assets/project-cover-community.png';
      if (tags.includes('design')) return 'assets/project-cover-design.png';
      if (tags.includes('engineering')) return 'assets/project-cover-engineering.png';
      if (tags.includes('research')) return 'assets/project-cover-research.png';
      return 'assets/project-cover-general.png';
    }

    function pinMarkup(project, index, owned = false) {
      const boosted = project.boost_until && new Date(project.boost_until) > new Date();
      const acceptingApplications = isAcceptingApplications(project);
      const statusClass = boosted
        ? 'is-boosted'
        : !acceptingApplications && project.status === 'open'
        ? 'is-paused'
        : project.status === 'invite_only'
        ? 'is-invite'
        : 'is-open';
      const statusLabel = boosted
        ? 'Boosted idea'
        : !acceptingApplications && project.status === 'open'
        ? 'Applications paused'
        : project.status === 'invite_only'
        ? 'Invite only'
        : 'Open project';
      const seatCount = Number(project.seats_total) || 0;
      const ownerLine = owned
        ? escapeHtml(project.status.replace('_', ' '))
        : project.owner_id
          ? `By <button type="button" class="link-button" data-view-profile="${escapeHtml(project.owner_id)}">${escapeHtml(project.owner)}</button>`
          : escapeHtml(`By ${project.owner}`);
      const seatSuffix = seatCount ? ` · ${seatCount} ${seatCount === 1 ? 'seat' : 'seats'}` : '';
      return `
        <article class="pin glass" data-od-id="${owned ? 'owned' : 'discover'}-project-${escapeHtml(project.id)}">
          <div class="pin-cover">
            <img src="${projectImageData(project) || projectCover(project)}" alt="" loading="lazy" decoding="async"
              onerror="this.onerror=null;this.src='${projectCover(project)}'">
            <span class="pin-status ${statusClass}">${statusLabel}</span>
          </div>
          <div class="pin-body">
            <h3 class="pin-title">${escapeHtml(project.title)}</h3>
            <p>${escapeHtml(project.summary)}</p>
            <div class="tags">${projectTags(project).map(tag => `<span class="tag">${escapeHtml(tag)}</span>`).join('')}</div>
            <div class="pin-foot">
              <span class="owner">${ownerLine}${escapeHtml(seatSuffix)}</span>
              <div class="pin-card-actions">
                ${owned ? '' : `<button class="btn btn-small" data-save="${escapeHtml(project.id)}" aria-pressed="${savedProjectIds.has(String(project.id))}" aria-label="${savedProjectIds.has(String(project.id)) ? 'Remove' : 'Save'} ${escapeHtml(project.title)}">${savedProjectIds.has(String(project.id)) ? 'Saved' : 'Save'}</button>`}
                <button class="btn btn-small" data-view="${escapeHtml(project.id)}" aria-label="View ${escapeHtml(project.title)}">View project</button>
              </div>
            </div>
            ${owned ? `
              <div class="project-actions">
                <button class="btn btn-small" data-edit="${escapeHtml(project.id)}">Edit</button>
                ${project.status === 'open' ? `<button class="btn btn-small" data-toggle-intake="${escapeHtml(project.id)}" aria-pressed="${!acceptingApplications}">${acceptingApplications ? 'Pause applications' : 'Resume applications'}</button>` : ''}
                <button class="btn btn-small" data-boost="${escapeHtml(project.id)}">${profile?.priority_match_active ? 'Use Plus boost' : 'Get Plus'}</button>
              </div>
            ` : ''}
          </div>
        </article>
      `;
    }

    function bindProjectButtons() {
      $$('[data-view]').forEach(button => button.onclick = () => openProjectDetail(button.dataset.view));
      $$('[data-save]').forEach(button => button.onclick = () => {
        const projectId = String(button.dataset.save);
        const project = projects.find(item => String(item.id) === projectId);
        if (savedProjectIds.has(projectId)) {
          savedProjectIds.delete(projectId);
          toast('Removed from saved projects.');
        } else {
          savedProjectIds.add(projectId);
          toast('Project saved.');
        }
        try {
          localStorage.setItem(savedProjectsKey, JSON.stringify([...savedProjectIds]));
        } catch (_) {}
        $('#saved-count').textContent = savedProjectIds.size;
        renderDiscovery();
        if (project && activeFilter !== 'saved') {
          const restoredButton = $(`[data-save="${CSS.escape(projectId)}"]`);
          if (restoredButton) restoredButton.focus();
        }
      });
      $$('[data-edit]').forEach(button => button.onclick = () => openProjectForm(
        ownedProjects.find(project => String(project.id) === button.dataset.edit)
      ));
      $$('[data-boost]').forEach(button => button.onclick = () => activateBoost(button.dataset.boost));
      $$('[data-toggle-intake]').forEach(button => button.onclick = () => toggleProjectIntake(button.dataset.toggleIntake));
    }

    function renderDiscovery() {
      if (loadError) {
        $('#discovery-board').innerHTML = `<div class="empty">The shared board could not be loaded.<br><button class="btn btn-small" id="retry-board" type="button">Retry</button></div>`;
        $('#retry-board').onclick = loadAll;
        return;
      }
      const items = filteredProjects();
      const filteredEmpty = activeFilter !== 'all' || $('#board-search').value.trim();
      const emptyMessage = activeFilter === 'saved' && !$('#board-search').value.trim()
        ? 'No saved projects yet. Save a project to keep it close for later.'
        : filteredEmpty
          ? 'No projects match the current search and filters.'
          : 'No open projects have been shared yet.';
      $('#discovery-board').innerHTML = items.length
        ? items.map((project, index) => pinMarkup(project, index)).join('')
        : `<div class="empty">
            <p>${emptyMessage}</p>
            <button class="btn btn-small" id="${filteredEmpty ? 'clear-board-view' : 'share-board-empty'}" type="button">
              ${activeFilter === 'saved' && !$('#board-search').value.trim() ? 'Browse all projects' : filteredEmpty ? 'Clear search and filters' : 'Post a project'}
            </button>
          </div>`;
      const clearView = $('#clear-board-view');
      if (clearView) {
        clearView.onclick = () => {
          activeFilter = 'all';
          $('#board-search').value = '';
          $$('[data-filter]').forEach(item => {
            const selected = item.dataset.filter === 'all';
            item.classList.toggle('active', selected);
            item.setAttribute('aria-pressed', String(selected));
          });
          renderDiscovery();
          $('#board-search').focus();
        };
      }
      const shareEmpty = $('#share-board-empty');
      if (shareEmpty) shareEmpty.onclick = () => openProjectForm();
      bindProjectButtons();
    }

    function renderOwned() {
      $('#owned-board').innerHTML = user
        ? ownedProjects.length
          ? ownedProjects.map((project, index) => pinMarkup(project, index, true)).join('')
          : '<div class="empty"><p>You have not posted a project yet.</p><button class="btn btn-primary" type="button" data-create-project>Post a project</button></div>'
        : authWall('Sign in to manage your projects.');
      bindProjectButtons();
      bindSigninButtons();
      $$('[data-create-project]').forEach(button => button.onclick = () => openProjectForm());
    }

    function renderRequests() {
      if (!user) {
        $('#request-list').innerHTML = authWall('Sign in to track your requests.');
        bindSigninButtons();
        return;
      }
      $('#request-list').innerHTML = sentApplications.length
        ? sentApplications.map(application => {
            const project = application.projects || {};
            const owner = project.profiles?.display_name || 'Project owner';
            const interview = interviews.find(item => String(item.application_id) === String(application.id));
            return `
              <article class="applicant glass" data-od-id="sent-request-${escapeHtml(application.id)}">
                <span class="avatar">${escapeHtml((project.title || 'cE').slice(0, 2).toUpperCase())}</span>
                <div>
                  <h3>${escapeHtml(project.title || 'Project request')}</h3>
                  <p>Sent to ${project.owner_id
                    ? `<button type="button" class="link-button" data-view-profile="${escapeHtml(project.owner_id)}">${escapeHtml(owner)}</button>`
                    : escapeHtml(owner)}</p>
                  <p>${escapeHtml(application.message)}</p>
                  <div class="request-meta">
                    <span>Sent ${escapeHtml(formatDate(application.created_at))}</span>
                    ${application.updated_at && application.updated_at !== application.created_at
                      ? `<span>Updated ${escapeHtml(formatDate(application.updated_at))}</span>`
                      : ''}
                  </div>
                </div>
                <div class="applicant-actions">
                  <span class="request-status" data-status="${escapeHtml(application.status)}">${escapeHtml(statusLabel(application.status))}</span>
                  ${interview?.meet_url
                    ? `<a class="btn btn-small" href="${escapeHtml(interview.meet_url)}" target="_blank" rel="noopener">Open Meet</a>`
                    : ''}
                  ${interview?.calendar_html_link
                    ? `<a class="btn btn-small" href="${escapeHtml(interview.calendar_html_link)}" target="_blank" rel="noopener">Open Calendar</a>`
                    : ''}
                  ${['accepted', 'interview'].includes(application.status) && reviewsAvailable
                    ? `<button class="btn btn-small" data-review-project="${escapeHtml(application.project_id)}">Review project team</button>`
                    : ''}
                </div>
              </article>
            `;
          }).join('')
        : '<div class="empty"><p>You have not sent a join request yet.</p><button class="btn btn-primary" type="button" data-find-projects>Find a project</button></div>';
      const findProjects = $('[data-find-projects]');
      if (findProjects) findProjects.onclick = () => switchPanel('discover');
      bindReviewButtons();
    }

    function renderNotifications() {
      const action = $('#notification-action');
      const list = $('#notification-list');
      const updates = user ? requestUpdates() : [];
      action.hidden = !user;
      $('#notification-count').textContent = updates.length ? String(updates.length) : '';
      list.innerHTML = sentApplications.filter(item => item.status !== 'pending').length
        ? sentApplications
            .filter(item => item.status !== 'pending')
            .slice(0, 8)
            .map(application => `
              <button class="notification-item" type="button" data-request-notification>
                <strong>${escapeHtml(application.projects?.title || 'Project request')}</strong>
                <span>Your request is ${escapeHtml(statusLabel(application.status).toLowerCase())} · ${escapeHtml(formatDate(application.updated_at || application.created_at))}</span>
              </button>
            `).join('')
        : '<div class="notification-empty">Status changes will appear here.</div>';
      $$('[data-request-notification]').forEach(button => {
        button.onclick = () => {
          $('#notification-panel').hidden = true;
          action.setAttribute('aria-expanded', 'false');
          switchPanel('requests');
        };
      });
    }

    function authWall(message) {
      return `<div class="auth-wall"><h2>${escapeHtml(message)}</h2><p>Your work stays tied to your account.</p><button class="btn btn-primary" data-google-signin>Continue with Google</button></div>`;
    }

    function renderApplicants() {
      if (!user) {
        $('#applicant-list').innerHTML = authWall('Sign in to review applicants.');
        bindSigninButtons();
        return;
      }
      const ordered = [...applications].sort((a, b) =>
        Number(Boolean(b.profiles?.priority_match_active)) -
        Number(Boolean(a.profiles?.priority_match_active)) ||
        new Date(b.created_at) - new Date(a.created_at)
      );
      const groups = new Map();
      for (const application of ordered) {
        const projectId = String(application.project_id);
        if (!groups.has(projectId)) {
          const ownedProject = ownedProjects.find(project => String(project.id) === projectId);
          groups.set(projectId, {
            project: ownedProject || application.projects || { id: projectId, title: 'Project' },
            applications: []
          });
        }
        groups.get(projectId).applications.push(application);
      }

      const applicantMarkup = application => {
        const person = application.profiles || {};
        const reputation = reviewSummary(person.id);
        const interview = interviews.find(item => String(item.application_id) === String(application.id));
        const answers = Object.values(application.answers || {}).filter(Boolean);
        const avatarInner = person.avatar_url
          ? `<img src="${escapeHtml(person.avatar_url)}" alt="">`
          : escapeHtml((person.display_name || 'cE').slice(0, 2).toUpperCase());
        const avatar = person.id
          ? `<button type="button" class="avatar" data-view-profile="${escapeHtml(person.id)}" aria-label="View ${escapeHtml(person.display_name || 'member')}&#39;s profile">${avatarInner}</button>`
          : `<span class="avatar">${avatarInner}</span>`;
        const pendingActions = application.status === 'pending'
          ? `
            <button class="btn btn-small" data-review="declined" data-id="${application.id}">Decline</button>
            <button class="btn btn-small" data-review="accepted" data-id="${application.id}">Accept</button>
            <button class="btn btn-small" data-interview="${application.id}">Interview</button>
          `
          : application.status === 'accepted'
            ? `
              <button class="btn btn-small" data-interview="${application.id}">Schedule interview</button>
              <button class="btn btn-small btn-ghost" data-review="pending" data-id="${application.id}">Cancel acceptance</button>
            `
            : application.status === 'interview'
              ? `<button class="btn btn-small" data-review="accepted" data-id="${application.id}">Accept</button>`
              : application.status === 'declined'
                ? `<button class="btn btn-small btn-ghost" data-review="pending" data-id="${application.id}">Reconsider</button>`
                : '';
        return `
          <article class="applicant" data-od-id="applicant-${escapeHtml(application.id)}">
            ${avatar}
            <div>
              <h3>
                ${person.id
                  ? `<button type="button" class="link-button" data-view-profile="${escapeHtml(person.id)}">${escapeHtml(person.display_name || 'Applicant')}</button>`
                  : escapeHtml(person.display_name || 'Applicant')}
                ${person.priority_match_active ? '<span class="badge priority">Priority</span>' : ''}
              </h3>
              <p>${escapeHtml(person.headline || 'No profile headline yet')}</p>
              ${reputation.received.length ? `<p><span class="reputation-stars">${starText(reputation.average)}</span> ${reputation.average.toFixed(1)} from ${reputation.received.length} verified ${reputation.received.length === 1 ? 'review' : 'reviews'}</p>` : ''}
              <div class="tags">${(person.skills || []).map(skill => `<span class="tag">${escapeHtml(skill)}</span>`).join('')}</div>
              <p>${escapeHtml(application.message)}</p>
              ${answers.length ? `<div class="answer-list">${answers.map(answer => `<span>— ${escapeHtml(answer)}</span>`).join('')}</div>` : ''}
            </div>
            <div class="applicant-actions">
              <span class="request-status" data-status="${escapeHtml(application.status)}">${escapeHtml(statusLabel(application.status))}</span>
              ${interview?.meet_url
                ? `<a class="btn btn-small" href="${escapeHtml(interview.meet_url)}" target="_blank" rel="noopener">Open Meet</a>`
                : ''}
              ${interview?.calendar_html_link
                ? `<a class="btn btn-small" href="${escapeHtml(interview.calendar_html_link)}" target="_blank" rel="noopener">Open Calendar</a>`
                : ''}
              ${pendingActions}
            </div>
          </article>
        `;
      };

      $('#applicant-list').classList.toggle('applicant-groups', Boolean(groups.size));
      $('#applicant-list').innerHTML = groups.size
        ? [...groups.values()].map(group => {
            const pending = group.applications.filter(application => application.status === 'pending').length;
            return `
              <section class="applicant-group" data-od-id="project-request-group-${escapeHtml(group.project.id)}">
                <div class="applicant-group-head">
                  <div>
                    <h3>${escapeHtml(group.project.title || 'Project')}</h3>
                    <p>${escapeHtml(group.project.summary || 'Requests from people who want to contribute.')}</p>
                  </div>
                  <div class="applicant-group-counts" aria-label="Request counts">
                    <span class="applicant-group-count">${group.applications.length} ${group.applications.length === 1 ? 'request' : 'requests'}</span>
                    ${pending ? `<span class="applicant-group-count pending">${pending} pending</span>` : ''}
                    ${reviewsAvailable && group.applications.some(application => ['accepted', 'interview'].includes(application.status))
                      ? `<button class="btn btn-small" data-review-project="${escapeHtml(group.project.id)}">Review participants</button>`
                      : ''}
                  </div>
                </div>
                <div class="applicant-group-list">
                  ${group.applications.map(applicantMarkup).join('')}
                </div>
              </section>
            `;
          }).join('')
        : '<div class="empty">No applications have reached your projects yet.</div>';

      $$('[data-review]').forEach(button => {
        button.onclick = () => reviewApplication(button.dataset.id, button.dataset.review);
      });
      $$('[data-interview]').forEach(button => {
        button.onclick = () => openInterview(button.dataset.interview);
      });
      bindReviewButtons();
    }

    function bindProfileViewButtons() {
      $$('[data-view-profile]').forEach(button => {
        button.onclick = () => openProfileView(button.dataset.viewProfile);
      });
    }

    async function openProfileView(profileId) {
      let target = await supabase
        .from('profiles')
        .select('id,display_name,headline,bio,skills,avatar_url,banner_url,priority_match_active')
        .eq('id', profileId)
        .maybeSingle();
      if (target.error && /permission denied/i.test(target.error.message)) {
        target = await supabase
          .from('profiles')
          .select('id,display_name,headline,bio,skills,avatar_url,priority_match_active')
          .eq('id', profileId)
          .maybeSingle();
      }
      if (target.error || !target.data) return toast('This profile could not be loaded.');
      const person = target.data;
      const displayName = person.display_name || 'connectEd member';
      $('#view-profile-name').textContent = displayName;
      $('#view-profile-headline').textContent = person.headline || 'No profile headline yet';
      const banner = $('#view-profile-banner');
      if (person.banner_url) {
        banner.style.backgroundImage = `url("${person.banner_url}")`;
        banner.hidden = false;
      } else {
        banner.style.backgroundImage = '';
        banner.hidden = true;
      }
      const photo = $('#view-profile-photo');
      const fallback = $('#view-profile-photo-fallback');
      photo.referrerPolicy = 'no-referrer';
      photo.onerror = () => { photo.hidden = true; fallback.hidden = false; };
      photo.hidden = !person.avatar_url;
      fallback.hidden = Boolean(person.avatar_url);
      if (person.avatar_url) photo.src = person.avatar_url;
      photo.alt = person.avatar_url ? `${displayName} profile photo` : '';
      fallback.textContent = displayName.slice(0, 2).toUpperCase();
      const reputation = reviewSummary(person.id);
      $('#view-profile-reputation').textContent = reputation.received.length
        ? `${starText(reputation.average)} ${reputation.average.toFixed(1)} from ${reputation.received.length} verified ${reputation.received.length === 1 ? 'review' : 'reviews'}`
        : 'No reviews yet';
      $('#view-profile-bio').textContent = person.bio || 'This member has not added a bio yet.';
      $('#view-profile-skills').innerHTML = (person.skills || [])
        .map(skill => `<span class="tag">${escapeHtml(skill)}</span>`).join('');
      $('#view-profile-reviews').innerHTML = reputation.received.slice(0, 4).map(review => `
        <article class="review-entry">
          <div class="review-entry-meta">
            <span>${review.reviewer_id
              ? `<button type="button" class="link-button" data-view-profile="${escapeHtml(review.reviewer_id)}">${escapeHtml(review.reviewer?.display_name || 'Project participant')}</button>`
              : escapeHtml(review.reviewer?.display_name || 'Project participant')} · ${escapeHtml(review.projects?.title || 'Project')}</span>
            <span class="reputation-stars">${starText(review.rating)}</span>
          </div>
          ${review.comment ? `<p>${escapeHtml(review.comment)}</p>` : ''}
        </article>
      `).join('');
      bindProfileViewButtons();
      openModal('view-profile');
    }

    function renderProfile() {
      $('#profile-wall').hidden = Boolean(user);
      $('#profile-content').hidden = !user;
      if (!user) {
        bindSigninButtons();
        return;
      }
      const avatarUrl = currentAvatarUrl();
      const profilePhoto = $('#profile-photo');
      const profileFallback = $('#profile-photo-fallback');
      const displayName = profile?.display_name || user.user_metadata?.full_name || user.email?.split('@')[0] || 'connectEd member';
      profilePhoto.referrerPolicy = 'no-referrer';
      profilePhoto.onerror = () => {
        profilePhoto.hidden = true;
        profileFallback.hidden = false;
      };
      profilePhoto.hidden = !avatarUrl;
      profileFallback.hidden = Boolean(avatarUrl);
      if (avatarUrl) profilePhoto.src = avatarUrl;
      profilePhoto.alt = avatarUrl ? `${displayName} profile photo` : '';
      profileFallback.textContent = displayName.slice(0, 2).toUpperCase();
      $('#profile-identity-name').textContent = displayName;
      $('#profile-identity-email').textContent = user.email || '';
      const banner = $('#profile-banner');
      if (profile?.banner_url) {
        banner.style.backgroundImage = `url("${profile.banner_url}")`;
        banner.hidden = false;
      } else {
        banner.style.backgroundImage = '';
        banner.hidden = true;
      }
      for (const key of ['display_name', 'headline', 'bio']) {
        $(`#profile-form [name=${key}]`).value = profile?.[key] || '';
      }
      $('#profile-form [name=skills]').value = (profile?.skills || []).join(', ');
      const location = profileLocation(profile);
      $('#profile-form [name=location_label]').value = location?.label || '';
      $('#profile-form [name=location_latitude]').value = location?.latitude ?? '';
      $('#profile-form [name=location_longitude]').value = location?.longitude ?? '';
      $('#location-shared').checked = Boolean(location);
      $('#location-status').textContent = location
        ? `Approximate location shared${location.label ? ` · ${location.label}` : ''}.`
        : 'No location collected.';
      $('#membership-title').textContent = profile?.priority_match_active ? 'connectEd Plus' : 'Free member';
      $('#membership-copy').textContent = profile?.priority_match_active
        ? 'Priority applications are active. Choose one project in My projects to boost.'
        : 'Applications and project sharing are free. Plus adds visibility in both roles.';
      $('#membership-action').textContent = profile?.priority_match_active ? 'Choose project to boost' : 'Get connectEd Plus';
      const reputation = reviewSummary(user.id);
      $('#reputation-score').textContent = reputation.received.length ? reputation.average.toFixed(1) : '—';
      $('#reputation-stars').textContent = reputation.received.length ? starText(reputation.average) : '';
      $('#reputation-meta').textContent = reputation.received.length
        ? `${reputation.received.length} verified ${reputation.received.length === 1 ? 'review' : 'reviews'}`
        : reviewsAvailable ? 'No reviews yet' : 'Reviews activate after the database update';
      $('#profile-review-list').innerHTML = reputation.received.slice(0, 4).map(review => `
        <article class="review-entry">
          <div class="review-entry-meta">
            <span>${review.reviewer_id
              ? `<button type="button" class="link-button" data-view-profile="${escapeHtml(review.reviewer_id)}">${escapeHtml(review.reviewer?.display_name || 'Project participant')}</button>`
              : escapeHtml(review.reviewer?.display_name || 'Project participant')} · ${escapeHtml(review.projects?.title || 'Project')}</span>
            <span class="reputation-stars">${starText(review.rating)}</span>
          </div>
          ${review.comment ? `<p>${escapeHtml(review.comment)}</p>` : ''}
        </article>
      `).join('');
      renderInterviewCalendar();
    }

    let calendarMonth = new Date();
    calendarMonth.setDate(1);
    let pendingAvatarDataUrl = null;
    let pendingBannerDataUrl = null;

    function userInterviews() {
      if (!user) return [];
      return interviews.filter(item => item.organizer_id === user.id || item.candidate_id === user.id);
    }

    function renderInterviewCalendar() {
      const card = $('#interview-calendar-card');
      if (!user) { card.hidden = true; return; }
      card.hidden = false;
      const year = calendarMonth.getFullYear();
      const month = calendarMonth.getMonth();
      $('#calendar-month-label').textContent = calendarMonth.toLocaleString([], { month: 'long', year: 'numeric' });

      const byDay = new Map();
      userInterviews().forEach(item => {
        const date = new Date(item.starts_at);
        const key = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
        if (!byDay.has(key)) byDay.set(key, []);
        byDay.get(key).push(item);
      });

      const startWeekday = new Date(year, month, 1).getDay();
      const daysInMonth = new Date(year, month + 1, 0).getDate();
      const today = new Date();
      const cells = Array(startWeekday).fill(null).concat(
        Array.from({ length: daysInMonth }, (_, index) => index + 1)
      );

      const grid = $('#calendar-grid');
      grid.innerHTML = ['S', 'M', 'T', 'W', 'T', 'F', 'S'].map(day => `<span class="calendar-weekday">${day}</span>`).join('')
        + cells.map(day => {
          if (!day) return '<span class="calendar-day calendar-day-blank"></span>';
          const dayItems = byDay.get(`${year}-${month}-${day}`) || [];
          const isToday = today.getFullYear() === year && today.getMonth() === month && today.getDate() === day;
          return `<button type="button" class="calendar-day${dayItems.length ? ' has-interview' : ''}${isToday ? ' today' : ''}" data-day="${day}">${day}${dayItems.length ? '<span class="calendar-dot"></span>' : ''}</button>`;
        }).join('');
      $$('.calendar-day[data-day]').forEach(button => {
        button.onclick = () => renderCalendarAgenda(Number(button.dataset.day), byDay, year, month);
      });

      const firstDayWithInterviews = [...byDay.keys()]
        .map(key => key.split('-').map(Number))
        .find(([keyYear, keyMonth]) => keyYear === year && keyMonth === month);
      if (firstDayWithInterviews) {
        renderCalendarAgenda(firstDayWithInterviews[2], byDay, year, month);
      } else {
        $('#calendar-agenda').innerHTML = '<p class="muted">No interviews this month.</p>';
      }
    }

    function renderCalendarAgenda(day, byDay, year, month) {
      const items = (byDay.get(`${year}-${month}-${day}`) || [])
        .slice()
        .sort((a, b) => new Date(a.starts_at) - new Date(b.starts_at));
      $('#calendar-agenda').innerHTML = items.length
        ? items.map(item => `
            <div class="calendar-agenda-item">
              <strong>${escapeHtml(item.title)}</strong>
              <span>${escapeHtml(new Date(item.starts_at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }))}</span>
              <div class="calendar-agenda-actions">
                ${item.meet_url ? `<a class="btn btn-small" href="${escapeHtml(item.meet_url)}" target="_blank" rel="noopener">Open Meet</a>` : ''}
                ${item.calendar_html_link ? `<a class="btn btn-small" href="${escapeHtml(item.calendar_html_link)}" target="_blank" rel="noopener">Open Calendar</a>` : ''}
              </div>
            </div>
          `).join('')
        : '<p class="muted">No interviews on this day.</p>';
    }

    $('#calendar-prev').onclick = () => {
      calendarMonth.setMonth(calendarMonth.getMonth() - 1);
      renderInterviewCalendar();
    };
    $('#calendar-next').onclick = () => {
      calendarMonth.setMonth(calendarMonth.getMonth() + 1);
      renderInterviewCalendar();
    };

    function bindSigninButtons() {
      $$('[data-google-signin]').forEach(button => {
        button.onclick = () => openAuthModal();
      });
    }

    function bindReviewButtons() {
      $$('[data-review-project]').forEach(button => {
        button.onclick = () => openReviewPicker(button.dataset.reviewProject);
      });
    }

    async function openReviewPicker(projectId) {
      if (!(await requireUser())) return;
      if (!reviewsAvailable) return toast('Participant reviews need the latest Supabase schema update.');
      const project = projects.find(item => String(item.id) === String(projectId))
        || sentApplications.find(item => String(item.project_id) === String(projectId))?.projects;
      if (!project) return toast('This project could not be loaded.');

      const result = await supabase
        .from('applications')
        .select('applicant_id,status,profiles:applicant_id(id,display_name,headline,avatar_url)')
        .eq('project_id', projectId)
        .in('status', ['accepted', 'interview']);
      if (result.error) return toast(result.error.message);

      const people = new Map();
      const ownerName = project.owner || project.profiles?.display_name || 'Project initiator';
      people.set(String(project.owner_id), {
        id: project.owner_id,
        display_name: ownerName,
        headline: 'Project initiator'
      });
      for (const application of result.data || []) {
        const person = application.profiles || {};
        people.set(String(application.applicant_id), {
          id: application.applicant_id,
          display_name: person.display_name || 'Project participant',
          headline: person.headline || 'Accepted participant',
          avatar_url: person.avatar_url || ''
        });
      }
      people.delete(String(user.id));
      const participants = [...people.values()];
      if (!participants.length) return toast('No other verified participants are available to review yet.');

      $('#review-title').textContent = `Review ${project.title || 'project'} participants`;
      $('#review-person-picker').hidden = false;
      $('#review-form').hidden = true;
      $('#review-people').innerHTML = participants.map(person => {
        const existing = projectReviews.find(review =>
          String(review.project_id) === String(projectId) &&
          String(review.reviewer_id) === String(user.id) &&
          String(review.reviewee_id) === String(person.id)
        );
        return `
          <button class="review-person" type="button"
            data-reviewee="${escapeHtml(person.id)}"
            data-reviewee-name="${escapeHtml(person.display_name)}"
            data-review-project-id="${escapeHtml(projectId)}">
            <span><strong>${escapeHtml(person.display_name)}</strong><br><span class="muted">${escapeHtml(person.headline)}</span></span>
            <span>${existing ? `Edit ${starText(existing.rating)}` : 'Leave review'}</span>
          </button>
        `;
      }).join('');
      $$('[data-reviewee]').forEach(button => {
        button.onclick = () => selectReviewPerson(
          button.dataset.reviewProjectId,
          button.dataset.reviewee,
          button.dataset.revieweeName
        );
      });
      openModal('review');
    }

    function selectReviewPerson(projectId, revieweeId, revieweeName) {
      const form = $('#review-form');
      form.reset();
      form.project_id.value = projectId;
      form.reviewee_id.value = revieweeId;
      const existing = projectReviews.find(review =>
        String(review.project_id) === String(projectId) &&
        String(review.reviewer_id) === String(user.id) &&
        String(review.reviewee_id) === String(revieweeId)
      );
      if (existing) {
        const rating = form.querySelector(`[name="rating"][value="${existing.rating}"]`);
        if (rating) rating.checked = true;
        form.comment.value = existing.comment || '';
      }
      $('#review-context').textContent = `Your verified review of ${revieweeName} will appear on their connectEd profile.`;
      $('#review-person-picker').hidden = true;
      form.hidden = false;
    }

    async function submitParticipantReview(form) {
      if (!(await requireUser())) return;
      const values = new FormData(form);
      const payload = {
        project_id: values.get('project_id'),
        reviewer_id: user.id,
        reviewee_id: values.get('reviewee_id'),
        rating: Number(values.get('rating')),
        comment: String(values.get('comment') || '').trim()
      };
      const result = await supabase
        .from('project_reviews')
        .upsert(payload, { onConflict: 'project_id,reviewer_id,reviewee_id' });
      if (result.error) return toast(result.error.message);
      closeModal('review');
      toast('Verified participant review published.');
      await loadAll();
    }

    async function openProjectDetail(id) {
      activeProject = projects.find(project => String(project.id) === String(id));
      if (!activeProject) return;
      $('#detail-title').textContent = activeProject.title;
      const detailSeats = Number(activeProject.seats_total) || 0;
      const detailSeatSuffix = detailSeats ? ` · ${detailSeats} ${detailSeats === 1 ? 'seat' : 'seats'}` : '';
      $('#detail-owner').innerHTML = activeProject.owner_id
        ? `Shared by <button type="button" class="link-button" data-view-profile="${escapeHtml(activeProject.owner_id)}">${escapeHtml(activeProject.owner)}</button>${escapeHtml(detailSeatSuffix)}`
        : escapeHtml(`Shared by ${activeProject.owner}${detailSeatSuffix}`);
      bindProfileViewButtons();
      $('#detail-description').textContent = activeProject.description;
      $('#detail-tags').innerHTML = projectTags(activeProject).map(tag => `<span class="tag">${escapeHtml(tag)}</span>`).join('');
      const detailCover = $('#detail-cover-image');
      const fallbackCover = projectCover(activeProject);
      detailCover.onerror = () => {
        detailCover.onerror = null;
        detailCover.src = fallbackCover;
      };
      detailCover.src = projectImageData(activeProject) || fallbackCover;
      detailCover.alt = `${activeProject.title} project cover`;
      // Three mutually exclusive states: already applied, paused, or open.
      const existingApplication = sentApplications.find(item => String(item.project_id) === String(activeProject.id));
      const pausedMessage = $('#application-paused-message');
      const canApply = activeProject.owner_id !== user?.id
        && isAcceptingApplications(activeProject)
        && !existingApplication;
      $('#application-form').hidden = !canApply;
      if (existingApplication) {
        pausedMessage.textContent = `You already sent a request to this project — current status: ${String(existingApplication.status).replace('_', ' ')}. Track it under My requests.`;
        pausedMessage.hidden = false;
      } else {
        pausedMessage.textContent = 'This project is visible, but the initiator has paused new applications.';
        pausedMessage.hidden = activeProject.owner_id === user?.id || isAcceptingApplications(activeProject);
      }

      let questions = [];
      if (isSupabaseConfigured && !String(id).startsWith('preview-')) {
        const result = await supabase.from('project_questions')
          .select('id,prompt,required,position').eq('project_id', id).order('position');
        questions = result.error ? [] : result.data || [];
      }
      activeProject.questions = questions;
      $('#application-questions').innerHTML = questions.map(question => `
        <label>${escapeHtml(question.prompt)}
          <textarea class="field" name="question-${question.id}" maxlength="2000" ${question.required ? 'required' : ''}></textarea>
        </label>
      `).join('');
      openModal('project-detail');
    }

    async function openProjectForm(project = null) {
      if (!(await requireUser())) return;
      editingProjectId = project?.id || null;
      editingQuestionId = null;
      const form = $('#project-form');
      form.reset();
      form.status.querySelector('option[value="invite_only"]')?.remove();
      resetProjectImagePreview();
      $('#project-form-title').textContent = project ? 'Edit your project' : 'Post a project';
      if (project) {
        form.title.value = project.title;
        form.summary.value = project.summary;
        form.description.value = project.description;
        form.tags.value = projectTags(project).join(', ');
        form.seats.value = project.seats_total;
        // Without this, the edit form always opened looking like the
        // project had no thumbnail at all — there was no way to see (let
        // alone deliberately keep or replace) the image it already had.
        const existingImage = projectImageData(project);
        if (existingImage) {
          $('#hub-image-preview-img').src = existingImage;
          $('#hub-image-preview').hidden = false;
        }
        // Legacy invite-only projects keep their status until the owner changes it;
        // the option itself is archived from the picker.
        if (project.status === 'invite_only') {
          const legacyOption = document.createElement('option');
          legacyOption.value = 'invite_only';
          legacyOption.textContent = 'Invite only (archived)';
          form.status.append(legacyOption);
        }
        form.status.value = project.status;
        const result = await supabase.from('project_questions')
          .select('id,prompt').eq('project_id', project.id).order('position').limit(1).maybeSingle();
        if (result.data) {
          editingQuestionId = result.data.id;
          form.question.value = result.data.prompt;
        }
      }
      openModal('project-form');
    }

    async function saveProject(form) {
      if (!(await requireUser())) return;
      const values = new FormData(form);
      const image = values.get('image');
      const tags = normalizeTags(values.get('tags'));
      const existingProject = editingProjectId
        ? projects.find(project => String(project.id) === String(editingProjectId))
        : null;
      const existingImage = projectImageData(existingProject);
      if (image instanceof File && image.size) {
        tags.push(await optimizeProjectImage(image));
      } else if (existingImage) {
        tags.push(`${PROJECT_IMAGE_PREFIX}${existingImage}`);
      }
      if ((existingProject?.tags || []).includes(APPLICATIONS_PAUSED_TAG)) {
        tags.push(APPLICATIONS_PAUSED_TAG);
      }
      const payload = {
        title: String(values.get('title')).trim(),
        summary: String(values.get('summary')).trim(),
        description: String(values.get('description')).trim(),
        tags,
        seats_total: Number(values.get('seats')),
        status: String(values.get('status'))
      };
      const result = editingProjectId
        ? await supabase.from('projects').update(payload).eq('id', editingProjectId).select('id').single()
        : await supabase.from('projects').insert({ ...payload, owner_id: user.id }).select('id').single();
      if (result.error) return toast(result.error.message);

      const projectId = result.data.id;
      const question = String(values.get('question') || '').trim();
      // The screening question is optional — only touch project_questions
      // when there's actually something to save, update, or clear.
      let questionResult = { error: null };
      if (question && editingQuestionId) {
        questionResult = await supabase.from('project_questions').update({ prompt: question }).eq('id', editingQuestionId);
      } else if (question) {
        questionResult = await supabase.from('project_questions').insert({ project_id: projectId, prompt: question, position: 0, required: true });
      } else if (editingQuestionId) {
        questionResult = await supabase.from('project_questions').delete().eq('id', editingQuestionId);
      }
      if (questionResult.error) return toast(questionResult.error.message);

      closeModal('project-form');
      toast(editingProjectId ? 'Project updated.' : 'Project published.');
      editingProjectId = null;
      editingQuestionId = null;
      await loadAll();
    }

    async function toggleProjectIntake(projectId) {
      if (!(await requireUser())) return;
      const project = ownedProjects.find(item => String(item.id) === String(projectId));
      if (!project) return;
      const tags = [...(project.tags || [])].filter(tag => String(tag) !== APPLICATIONS_PAUSED_TAG);
      const currentlyAccepting = isAcceptingApplications(project);
      if (currentlyAccepting) tags.push(APPLICATIONS_PAUSED_TAG);
      const result = await supabase.from('projects').update({ tags }).eq('id', project.id);
      if (result.error) return toast(result.error.message);
      toast(currentlyAccepting ? 'New applications paused.' : 'New applications resumed.');
      await loadAll();
    }

    function resetProjectImagePreview() {
      const preview = $('#hub-image-preview');
      const image = $('#hub-image-preview-img');
      if (image.dataset.objectUrl) URL.revokeObjectURL(image.dataset.objectUrl);
      image.removeAttribute('src');
      image.dataset.objectUrl = '';
      preview.hidden = true;
    }

    $('#hub-project-image').onchange = event => {
      resetProjectImagePreview();
      const file = event.target.files?.[0];
      if (!file) return;
      if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 8 * 1024 * 1024) {
        event.target.value = '';
        toast('Choose a JPEG, PNG, or WebP image up to 8 MB.');
        return;
      }
      const objectUrl = URL.createObjectURL(file);
      $('#hub-image-preview-img').src = objectUrl;
      $('#hub-image-preview-img').dataset.objectUrl = objectUrl;
      $('#hub-image-preview').hidden = false;
    };

    $('#profile-photo-input').onchange = async event => {
      const file = event.target.files?.[0];
      event.target.value = '';
      if (!file) return;
      const status = $('#profile-photo-status');
      status.hidden = false;
      status.textContent = 'Optimizing photo…';
      try {
        pendingAvatarDataUrl = await optimizeAvatarImage(file);
        $('#profile-photo').src = pendingAvatarDataUrl;
        $('#profile-photo').hidden = false;
        $('#profile-photo-fallback').hidden = true;
        status.textContent = 'Photo ready — save your profile to publish it.';
      } catch (error) {
        status.textContent = error.message || 'Photo could not be processed.';
      }
    };

    $('#profile-banner-input').onchange = async event => {
      const file = event.target.files?.[0];
      event.target.value = '';
      if (!file) return;
      try {
        pendingBannerDataUrl = await optimizeBannerImage(file);
        const banner = $('#profile-banner');
        banner.style.backgroundImage = `url("${pendingBannerDataUrl}")`;
        banner.hidden = false;
        toast('Cover image ready — save your profile to publish it.');
      } catch (error) {
        toast(error.message || 'Cover image could not be processed.');
      }
    };

    async function submitApplication(form) {
      if (!(await requireUser())) return;
      if (!activeProject || String(activeProject.id).startsWith('preview-')) return toast('Preview projects do not accept applications.');
      if (activeProject.owner_id === user.id) return toast('You already own this project.');
      if (!isAcceptingApplications(activeProject)) return toast('This project has paused new applications.');
      const values = new FormData(form);
      const answers = {};
      for (const question of activeProject.questions || []) {
        answers[question.id] = String(values.get(`question-${question.id}`) || '').trim();
      }
      const result = await supabase.from('applications').insert({
        project_id: activeProject.id,
        applicant_id: user.id,
        message: String(values.get('message')).trim(),
        answers
      });
      if (result.error) return toast(result.error.code === '23505' ? 'You already applied to this project.' : result.error.message);
      form.reset();
      closeModal('project-detail');
      toast('Application sent.');
      await loadAll();
    }

    async function reviewApplication(id, status) {
      // seats_total was purely decorative — nothing stopped an owner from
      // accepting past the stated capacity. Warn instead of silently
      // allowing it; final call still stays with the owner.
      if (status === 'accepted') {
        const application = applications.find(item => String(item.id) === String(id));
        const project = application && ownedProjects.find(item => String(item.id) === String(application.project_id));
        if (project) {
          const seatLimit = Number(project.seats_total) || 0;
          const filledSeats = applications.filter(item =>
            String(item.project_id) === String(project.id) &&
            String(item.id) !== String(id) &&
            ['accepted', 'interview'].includes(item.status)
          ).length;
          if (seatLimit && filledSeats >= seatLimit) {
            const proceed = window.confirm(
              `${project.title} lists ${seatLimit} ${seatLimit === 1 ? 'seat' : 'seats'} and already has ${filledSeats} accepted or in interview. Accept anyway?`
            );
            if (!proceed) return;
          }
        }
      }
      const result = await supabase.from('applications').update({ status }).eq('id', id);
      if (result.error) return toast(result.error.message);
      toast(
        status === 'accepted' ? 'Applicant accepted.'
          : status === 'declined' ? 'Application declined.'
          : 'Decision cancelled — back to pending.'
      );
      await loadAll();
    }

    async function openInterview(id) {
      const application = applications.find(item => String(item.id) === String(id));
      if (!application) return;
      const form = $('#interview-form');
      form.reset();
      form.hidden = false;
      $('#interview-result').hidden = true;
      form.application_id.value = application.id;
      form.project_id.value = application.project_id;
      form.candidate_id.value = application.applicant_id;
      form.title.value = `${application.projects?.title || 'connectEd'} interview`;
      const suggestedStart = new Date(Date.now() + 60 * 60 * 1000);
      suggestedStart.setMinutes(Math.ceil(suggestedStart.getMinutes() / 30) * 30, 0, 0);
      const localDate = date => [
        date.getFullYear(),
        String(date.getMonth() + 1).padStart(2, '0'),
        String(date.getDate()).padStart(2, '0')
      ].join('-');
      form.date.min = localDate(new Date());
      form.date.value = localDate(suggestedStart);
      form.time.value = `${String(suggestedStart.getHours()).padStart(2, '0')}:${String(suggestedStart.getMinutes()).padStart(2, '0')}`;
      syncTimeMin(form);
      // Emails live in auth.users, which the browser cannot read — there is
      // no profiles.email column to pre-fill from. The serverless endpoint
      // resolves the real address with the service-role key, so leave this
      // blank and let it stay optional as an override.
      form.email.value = '';
      openModal('interview');
    }

    // Keep the time picker honest: when the chosen date is today, the
    // earliest selectable time is the next quarter hour.
    function syncTimeMin(form) {
      const today = new Date();
      const todayValue = [
        today.getFullYear(),
        String(today.getMonth() + 1).padStart(2, '0'),
        String(today.getDate()).padStart(2, '0')
      ].join('-');
      if (form.date.value === todayValue) {
        const floor = new Date(today.getTime() + 15 * 60 * 1000);
        form.time.min = `${String(floor.getHours()).padStart(2, '0')}:${String(floor.getMinutes()).padStart(2, '0')}`;
      } else {
        form.time.removeAttribute('min');
      }
    }
    $('#interview-form [name=date]').onchange = () => syncTimeMin($('#interview-form'));

    async function scheduleInterview(form) {
      const values = new FormData(form);
      const startsAt = new Date(`${String(values.get('date'))}T${String(values.get('time'))}:00`);
      const durationMinutes = Number(values.get('duration'));
      const endsAt = new Date(startsAt.getTime() + durationMinutes * 60 * 1000);
      if (Number.isNaN(startsAt.getTime()) || ![15, 30, 45, 60, 90].includes(durationMinutes)) {
        return toast('Choose a valid interview date, time, and duration.');
      }
      if (startsAt.getTime() < Date.now() + 5 * 60 * 1000) {
        return toast('Pick a start time at least five minutes from now.');
      }
      // No Google token to attach here — the server holds a stored refresh
      // token from sign-in and mints its own access token per request.
      const response = await fetch('/api/google-calendar', {
        method: 'POST',
        headers: await authHeaders(),
        body: JSON.stringify({
          applicationId: values.get('application_id'),
          projectId: values.get('project_id'),
          title: values.get('title'),
          startsAt: startsAt.toISOString(),
          endsAt: endsAt.toISOString(),
          notes: values.get('notes'),
          attendeeEmail: values.get('email')
        })
      });
      const data = await response.json();
      if (!response.ok) {
        if (data.needsGoogleReconnect) {
          toast(data.error || 'Reconnect Google to grant Calendar access.');
          return beginGoogleSignIn();
        }
        return toast(data.error || 'Calendar event could not be created.');
      }

      const interviewRow = {
        project_id: values.get('project_id'),
        application_id: values.get('application_id'),
        organizer_id: user.id,
        candidate_id: values.get('candidate_id'),
        starts_at: startsAt.toISOString(),
        ends_at: endsAt.toISOString(),
        title: String(values.get('title')).trim(),
        notes: String(values.get('notes')).trim(),
        google_event_id: data.eventId,
        meet_url: data.meetUrl,
        calendar_html_link: data.htmlLink
      };
      let saved = await supabase.from('interviews').insert(interviewRow);
      if (saved.error && /permission denied/i.test(saved.error.message)) {
        delete interviewRow.calendar_html_link;
        saved = await supabase.from('interviews').insert(interviewRow);
      }
      if (saved.error) return toast(saved.error.message);
      const statusUpdate = await supabase.from('applications').update({ status: 'interview' }).eq('id', values.get('application_id'));
      if (statusUpdate.error) toast('The Meet was created, but the application status could not be updated.');
      form.hidden = true;
      const result = $('#interview-result');
      const meetLink = $('#interview-meet-link');
      const copyMeetLink = $('#copy-meet-link');
      const calendarLink = $('#interview-calendar-link');
      meetLink.hidden = !data.meetUrl;
      copyMeetLink.hidden = !data.meetUrl;
      meetLink.href = data.meetUrl || '#';
      copyMeetLink.dataset.url = data.meetUrl || '';
      calendarLink.hidden = !data.htmlLink;
      calendarLink.href = data.htmlLink || '#';
      $('#interview-result-time').textContent = `${startsAt.toLocaleString([], { dateStyle: 'full', timeStyle: 'short' })} · ${durationMinutes} minutes`;
      result.hidden = false;
      toast(data.meetUrl ? 'Interview scheduled. Your Meet link is ready.' : 'Interview added to Google Calendar.');
      await loadAll();
    }

    $('#copy-meet-link').onclick = async event => {
      const url = event.currentTarget.dataset.url;
      if (!url) return;
      try {
        await navigator.clipboard.writeText(url);
        toast('Google Meet link copied.');
      } catch (_) {
        toast('Open the Meet link and copy it from your browser.');
      }
    };

    let checkoutPending = false;

    async function startCheckout(projectId = '') {
      if (checkoutPending) return;
      if (!(await requireUser())) return;
      checkoutPending = true;
      const controls = $$('#membership-action, [data-boost]');
      controls.forEach(button => button.disabled = true);
      try {
        const response = await fetch('/api/create-checkout-session', {
          method: 'POST',
          headers: await authHeaders(),
          body: JSON.stringify({ plan: 'connected_plus', projectId })
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Checkout is unavailable.');
        window.location.href = data.url;
      } catch (error) {
        toast(error.message || 'Checkout is unavailable.');
      } finally {
        checkoutPending = false;
        controls.forEach(button => button.disabled = false);
      }
    }

    async function activateBoost(projectId) {
      if (!profile?.priority_match_active) return startCheckout(projectId);
      const result = await supabase.rpc('activate_plus_boost', { target_project: projectId });
      if (result.error) return toast(result.error.message);
      toast('Your Plus boost is active on this project.');
      await loadAll();
    }

      // Typing a city needs no GPS permission — geocode it through a free,
      // keyless lookup so "share location" works either way.
    async function geocodeLabel(label) {
      try {
        const response = await fetch(
          `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(label)}`,
          { headers: { Accept: 'application/json' } }
        );
        if (!response.ok) return null;
        const results = await response.json();
        const match = results[0];
        if (!match) return null;
        return { latitude: Number(match.lat), longitude: Number(match.lon) };
      } catch (_) {
        return null;
      }
    }

    async function saveProfile(form) {
      const values = new FormData(form);
      const shareLocation = values.get('location_shared') === 'on';
      const labelValue = String(values.get('location_label') || '').trim().slice(0, 100);
      let latitudeValue = String(values.get('location_latitude') || '').trim();
      let longitudeValue = String(values.get('location_longitude') || '').trim();
      if (shareLocation && (!latitudeValue || !longitudeValue) && labelValue) {
        $('#location-status').textContent = 'Looking up that location…';
        const geocoded = await geocodeLabel(labelValue);
        if (geocoded) {
          latitudeValue = String(geocoded.latitude);
          longitudeValue = String(geocoded.longitude);
          $('#profile-form [name=location_latitude]').value = latitudeValue;
          $('#profile-form [name=location_longitude]').value = longitudeValue;
        }
      }
      const latitude = Number(latitudeValue);
      const longitude = Number(longitudeValue);
      if (
        shareLocation &&
        (
          !latitudeValue ||
          !longitudeValue ||
          !Number.isFinite(latitude) ||
          !Number.isFinite(longitude)
        )
      ) {
        return toast('Type a city we can find (e.g. "Seoul, South Korea"), or use "Use my current location".');
      }
      const location = shareLocation
        ? {
            shared: true,
            label: labelValue,
            latitude: Number(latitude.toFixed(2)),
            longitude: Number(longitude.toFixed(2))
          }
        : null;
      const profileBase = {
        display_name: String(values.get('display_name')).trim(),
        headline: String(values.get('headline')).trim(),
        bio: String(values.get('bio')).trim(),
        skills: normalizeTags(values.get('skills'))
      };
      const imageUpdates = {
        ...(pendingAvatarDataUrl ? { avatar_url: pendingAvatarDataUrl, custom_avatar: true } : {}),
        ...(pendingBannerDataUrl ? { banner_url: pendingBannerDataUrl } : {})
      };
      // profiles.location_* is the only place location is written now — no
      // parallel auth-metadata copy and no per-project tag to keep in sync.
      let savedMessage = 'Profile saved.';
      let result = await supabase.from('profiles').update({
        ...profileBase,
        ...imageUpdates,
        location_label: location?.label || null,
        location_latitude: location?.latitude ?? null,
        location_longitude: location?.longitude ?? null
      }).eq('id', user.id);
      if (result.error && /permission denied/i.test(result.error.message)) {
        // The location columns migration has not been applied yet — save the
        // rest of the profile; location can't be persisted until it is.
        result = await supabase.from('profiles').update({ ...profileBase, ...imageUpdates }).eq('id', user.id);
        if (location) savedMessage = 'Profile saved, but location needs a database migration first.';
      }
      if (result.error && /permission denied/i.test(result.error.message)) {
        // Photo/cover columns not migrated yet — save the rest of the
        // profile rather than blocking the whole form on it.
        result = await supabase.from('profiles').update(profileBase).eq('id', user.id);
        savedMessage = 'Profile saved, but photo/cover updates need a database migration first.';
      }
      if (result.error) return toast(result.error.message);
      pendingAvatarDataUrl = null;
      pendingBannerDataUrl = null;
      toast(savedMessage);
      await loadAll();
    }

    $('#use-current-location').onclick = event => {
      const button = event.currentTarget;
      if (!navigator.geolocation) return toast('Location is not supported by this browser.');
      button.disabled = true;
      button.textContent = 'Locating…';
      $('#location-status').textContent = 'Waiting for browser permission…';
      navigator.geolocation.getCurrentPosition(position => {
        const latitude = Number(position.coords.latitude.toFixed(2));
        const longitude = Number(position.coords.longitude.toFixed(2));
        $('#profile-form [name=location_latitude]').value = latitude;
        $('#profile-form [name=location_longitude]').value = longitude;
        $('#location-shared').checked = true;
        $('#location-status').textContent = 'Approximate location ready. Save your profile to share it.';
        button.disabled = false;
        button.textContent = 'Update current location';
      }, error => {
        $('#location-status').textContent = 'No location collected.';
        button.disabled = false;
        button.textContent = 'Use my current location';
        toast(error.code === 1 ? 'Location permission was not granted.' : 'Your location could not be determined.');
      }, {
        enableHighAccuracy: false,
        timeout: 10000,
        maximumAge: 300000
      });
    };

    // Typing a city without also ticking the box below was a silent no-op —
    // shareLocation read as false, so saveProfile treated it as "no
    // location" and discarded the typed label entirely. Checking the box
    // automatically once there's text to share removes that trap.
    $('#profile-form [name=location_label]').addEventListener('input', event => {
      if (event.target.value.trim()) $('#location-shared').checked = true;
    });

    $('#location-shared').onchange = event => {
      if (event.currentTarget.checked) return;
      $('#profile-form [name=location_latitude]').value = '';
      $('#profile-form [name=location_longitude]').value = '';
      $('#location-status').textContent = 'Location will be removed when you save your profile.';
    };

    function switchPanel(name) {
      $$('.panel').forEach(panel => panel.hidden = panel.id !== `panel-${name}`);
      $$('[data-panel]').forEach(tab => {
        const selected = tab.dataset.panel === name;
        tab.classList.toggle('active', selected);
        tab.setAttribute('aria-selected', String(selected));
        tab.tabIndex = selected ? 0 : -1;
      });
      if (name === 'profile') renderProfile();
      if (name === 'requests') renderRequests();
    }

    function bindAsyncForm(selector, handler, pendingLabel) {
      const form = $(selector);
      form.onsubmit = async event => {
        event.preventDefault();
        const submit = form.querySelector('[type="submit"]');
        const originalLabel = submit?.textContent;
        form.setAttribute('aria-busy', 'true');
        if (submit) {
          submit.disabled = true;
          submit.textContent = pendingLabel;
        }
        try {
          await handler(form);
        } catch (error) {
          toast(error.message || 'Something went wrong. Please try again.');
        } finally {
          form.setAttribute('aria-busy', 'false');
          if (submit) {
            submit.disabled = false;
            submit.textContent = originalLabel;
          }
        }
      };
    }

    $('#board-search').oninput = renderDiscovery;
    $('#new-project').onclick = () => openProjectForm();
    $$('[data-create-project]').forEach(button => button.onclick = () => openProjectForm());
    bindAsyncForm('#project-form', saveProject, 'Saving…');
    bindAsyncForm('#application-form', submitApplication, 'Sending…');
    bindAsyncForm('#interview-form', scheduleInterview, 'Scheduling…');
    bindAsyncForm('#review-form', submitParticipantReview, 'Publishing…');
    bindAsyncForm('#profile-form', saveProfile, 'Saving…');
    $('#membership-action').onclick = () => profile?.priority_match_active
      ? switchPanel('owned')
      : startCheckout();
    $('#notification-action').onclick = event => {
      event.stopPropagation();
      const panel = $('#notification-panel');
      const willOpen = panel.hidden;
      if (willOpen) {
        const anchor = event.currentTarget.getBoundingClientRect();
        panel.style.top = `${anchor.bottom + 8}px`;
        panel.style.right = `${window.innerWidth - anchor.right}px`;
      }
      panel.hidden = !willOpen;
      $('#notification-action').setAttribute('aria-expanded', String(willOpen));
      if (willOpen && user) {
        localStorage.setItem(requestSeenKey(), String(Date.now()));
        $('#notification-count').textContent = '';
      }
    };
    $('#notification-panel').onclick = event => event.stopPropagation();
    $('#notification-view-all').onclick = () => {
      $('#notification-panel').hidden = true;
      $('#notification-action').setAttribute('aria-expanded', 'false');
      switchPanel('requests');
    };
    $('#review-back').onclick = () => {
      $('#review-form').hidden = true;
      $('#review-person-picker').hidden = false;
    };
    document.addEventListener('click', () => {
      $('#notification-panel').hidden = true;
      $('#notification-action').setAttribute('aria-expanded', 'false');
    });

    const panelTabs = $$('[data-panel]');
    panelTabs.forEach(tab => {
      tab.onclick = () => switchPanel(tab.dataset.panel);
      tab.onkeydown = event => {
        const currentIndex = panelTabs.indexOf(tab);
        let nextIndex = currentIndex;
        if (event.key === 'ArrowRight') nextIndex = (currentIndex + 1) % panelTabs.length;
        else if (event.key === 'ArrowLeft') nextIndex = (currentIndex - 1 + panelTabs.length) % panelTabs.length;
        else if (event.key === 'Home') nextIndex = 0;
        else if (event.key === 'End') nextIndex = panelTabs.length - 1;
        else return;
        event.preventDefault();
        const nextTab = panelTabs[nextIndex];
        switchPanel(nextTab.dataset.panel);
        nextTab.focus();
      };
    });
    $$('[data-close]').forEach(button => button.onclick = () => closeModal(button.dataset.close));
    $$('.modal-backdrop').forEach(backdrop => {
      backdrop.onclick = event => {
        if (event.target === backdrop) closeModal(backdrop.id.replace('modal-', ''));
      };
    });
    bindSigninButtons();

    const query = new URLSearchParams(window.location.search);
    const checkoutState = query.get('checkout');
    const authIntent = query.get('auth');
    if (checkoutState === 'success') toast('Payment received. Plus activates after Stripe confirms it.');
    if (checkoutState === 'cancelled') toast('Checkout cancelled. Nothing was charged.');

    // Register auth listener BEFORE the first loadAll so initial session
    // restoration triggers a UI refresh — without this, signing in works but
    // the UI stays in signed-out state until a manual reload.
    if (supabase) {
      supabase.auth.onAuthStateChange((_event, session) => {
        window.setTimeout(loadAll, 0);
        // Only present in the session object once, right after the OAuth
        // redirect completes — store it now or lose the chance until the
        // next sign-in.
        if (session?.provider_refresh_token) {
          storeGoogleRefreshToken(session.provider_refresh_token);
        }
      });
      window.setInterval(pollRequestStatuses, 45000);
      document.addEventListener('visibilitychange', () => {
        if (!document.hidden) pollRequestStatuses();
      });
    }
    await loadAll();
    if (authIntent === 'google' && !user) {
      const cleanUrl = new URL(window.location.href);
      cleanUrl.searchParams.delete('auth');
      cleanUrl.searchParams.delete('return');
      window.history.replaceState(null, '', cleanUrl);
      await beginGoogleSignIn();
    }
