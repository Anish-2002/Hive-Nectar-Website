import { handleLogin } from './login.js';
import { handleSignup } from './signup.js';
import { initProfile } from './profile.js';
import { supabase } from './supabase-config.js';
import { handleContactSubmit } from './contact.js';
import { initCommunicationBoard, initHomeNotifications } from './comms.js';

// ======================== THEME CACHING ========================
const THEME_CACHE_KEY = 'hive_theme_cache';
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours

// Apply theme object to CSS variables
function applyTheme(theme) {
    const root = document.documentElement;
    root.style.setProperty('--bg', theme.bg);
    root.style.setProperty('--card', theme.card_bg);
    root.style.setProperty('--primary', theme.primary_color);
    root.style.setProperty('--primary-dark', theme.primary_color);
    root.style.setProperty('--secondary', theme.secondary_color);
    root.style.setProperty('--fg', theme.fg);
    root.style.setProperty('--fg-muted', theme.fg_muted);
    root.style.setProperty('--border', theme.border_color);
    root.style.setProperty('--honey-gradient', theme.primary_gradient);
    root.style.setProperty('--deep-meadow', theme.deep_meadow);
    root.style.setProperty('--terra', theme.terra);
    root.style.setProperty('--honey-glow', `0 8px 32px ${theme.primary_color}40`);
    root.style.setProperty('--honey-gradient-dark', `linear-gradient(135deg, ${theme.primary_color}, ${theme.deep_meadow})`);
    root.style.setProperty('--card-shadow', '0 4px 24px rgba(0, 0, 0, 0.05)');
    root.style.setProperty('--card-shadow-hover', '0 12px 40px rgba(0, 0, 0, 0.1)');
}

// Fallback Meadow palette
function getFallbackTheme() {
    return {
        bg: '#F2EBD9',
        card_bg: '#FFFFFF',
        primary_color: '#C8A96E',
        secondary_color: '#7A9E7E',
        fg: '#3D2E1E',
        fg_muted: '#7A6B5D',
        border_color: '#D4C5A9',
        primary_gradient: 'linear-gradient(135deg, #C8A96E, #7A9E7E)',
        deep_meadow: '#4A6741',
        terra: '#B5835A'
    };
}

// Fetch fresh theme from Supabase and update cache
async function fetchThemeAndUpdateCache() {
    try {
        const { data, error } = await supabase
            .from('theme_settings')
            .select('*')
            .eq('id', 1)
            .single();
        
        if (error || !data) throw error;
        
        applyTheme(data);
        localStorage.setItem(THEME_CACHE_KEY, JSON.stringify({
            data: data,
            timestamp: Date.now()
        }));
    } catch (err) {
        console.warn('Failed to fetch theme, using fallback');
        const fallback = getFallbackTheme();
        applyTheme(fallback);
        localStorage.setItem(THEME_CACHE_KEY, JSON.stringify({
            data: fallback,
            timestamp: Date.now()
        }));
    }
}
// Global variable to track subscription
let themeSubscription = null;

// Subscribe to realtime changes on theme_settings
function subscribeToThemeChanges() {
    if (themeSubscription) {
        // Already subscribed, do nothing
        return;
    }
    
    themeSubscription = supabase
        .channel('theme_settings_changes')
        .on(
            'postgres_changes',
            {
                event: 'UPDATE',
                schema: 'public',
                table: 'theme_settings',
                filter: 'id=eq.1'
            },
            (payload) => {
                console.log('🎨 Theme updated in realtime:', payload.new);
                // Apply new colors immediately
                applyTheme(payload.new);
                // Update cache with new colors
                localStorage.setItem(THEME_CACHE_KEY, JSON.stringify({
                    data: payload.new,
                    timestamp: Date.now()
                }));
                // Optional: Show a small notification
                const toast = document.createElement('div');
                toast.className = 'toast success';
                toast.innerHTML = '<i class="fas fa-palette"></i><span>Theme updated live!</span>';
                document.getElementById('toast-container')?.appendChild(toast);
                setTimeout(() => toast.remove(), 3000);
            }
        )
        .subscribe((status) => {
            if (status === 'SUBSCRIBED') {
                console.log('✅ Listening for theme changes');
            }
        });
}
// Main theme loader – applies cached theme instantly, then updates in background
// Main theme loader – applies cached theme instantly, then updates in background
async function loadSiteTheme() {
    // 1. Try cache first (synchronous, no lag)
    const cached = localStorage.getItem(THEME_CACHE_KEY);
    if (cached) {
        try {
            const { data, timestamp } = JSON.parse(cached);
            applyTheme(data);
            // Subscribe to realtime changes (non-blocking)
            subscribeToThemeChanges();
            // Refresh cache in background if expired
            if (Date.now() - timestamp >= CACHE_TTL) {
                fetchThemeAndUpdateCache(); // fire-and-forget
            }
            return;
        } catch(e) {
            console.warn("Invalid cache", e);
        }
    }
    
    // 2. No cache or invalid: fetch now (may cause slight lag on first load)
    await fetchThemeAndUpdateCache();
    // After fetching, subscribe to realtime
    subscribeToThemeChanges();
}

// ======================== EXPORT LOADER (unchanged) ========================
export const Loader = {
    show(message = "Loading...") {
        const loader = document.getElementById('global-loader');
        const text = document.getElementById('loader-text');
        if (loader) {
            if (text) text.innerText = message;
            loader.style.display = 'flex';
        }
    },
    hide() {
        const loader = document.getElementById('global-loader');
        if (loader) loader.style.display = 'none';
    }
};

// ======================== DOM CONTENT LOADED ========================
document.addEventListener('DOMContentLoaded', async () => {
    // Load theme (cached instantly, no lag)
    await loadSiteTheme();  // await is fine here because cache applies sync
    
    const path = window.location.pathname;

    if (path.includes('profile.html')) {
        console.log("Initializing Profile...");
        initProfile();
    }

    if (path.includes('contact.html')) {
        const contactForm = document.getElementById('contactForm');
        if (contactForm) {
            contactForm.addEventListener('submit', handleContactSubmit);
        }
    }

    if (path === '/' || path.includes('index.html')) {
        initHomeNotifications();
    }

    if (path.includes('board.html')) {
        initCommunicationBoard();
    }

    const signupForm = document.getElementById('signupForm');
    if (signupForm) {
        signupForm.addEventListener('submit', handleSignup);
    }

    if (window.location.hash.includes('type=recovery')) {
        supabase.auth.onAuthStateChange(async (event) => {
            if (event === "PASSWORD_RECOVERY") {
                showToast("Verification Successful! Redirecting to reset page...");
                window.location.replace('./reset-password.html');
            }
        });
    }

    const loginForm = document.getElementById('loginForm');
    if (loginForm) {
        loginForm.addEventListener('submit', handleLogin);
    }

    const menuToggle = document.getElementById('menuToggle');
    const navLinks = document.getElementById('navLinks');
    if (menuToggle && navLinks) {
        menuToggle.addEventListener('click', function() {
            navLinks.classList.toggle('show');
        });
    }
});

export function showToast(message, type = 'success') {
    let container = document.getElementById('toast-container');
    if (!container) {
        container = document.createElement('div');
        container.id = 'toast-container';
        document.body.appendChild(container);
    }

    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    const iconClass = type === 'error' ? 'fa-circle-exclamation' : 'fa-check-circle';
    toast.innerHTML = `<i class="fas ${iconClass}"></i><span>${message}</span>`;
    container.appendChild(toast);

    setTimeout(() => {
        toast.style.animation = 'fadeOut 0.5s forwards';
        setTimeout(() => toast.remove(), 500);
    }, 4000);
}
window.showToast = showToast;