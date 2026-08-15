//! Marlin, spike 1.
//!
//! Goal, from notes/Projects/Marlin/Daily Tasks.md: **one glyph on screen from a
//! real pty**, and a prompt you can type into. No tabs, no splits, no config.
//!
//! The two things this spike exists to prove, because everything else in the
//! plan depends on them:
//!   1. winit + wgpu + glyphon + alacritty_terminal actually compose.
//!   2. Rendering is damage-driven: nothing redraws when nothing changed.
//!
//! It is deliberately one file and deliberately throwaway.

use std::sync::{Arc, Mutex};

use alacritty_terminal::event::{Event as TermEvent, EventListener, Notify, WindowSize};
use alacritty_terminal::event_loop::{EventLoop as PtyEventLoop, Msg, Notifier};
use alacritty_terminal::grid::Dimensions;
use alacritty_terminal::index::{Column, Line};
use alacritty_terminal::sync::FairMutex;
use alacritty_terminal::term::{Config as TermConfig, Term};
use alacritty_terminal::tty;
use alacritty_terminal::vte::ansi::{Color as AnsiColor, NamedColor};

use glyphon::{
    Attrs, Buffer, Cache, Color as GColor, Family, FontSystem, Metrics, Resolution, Shaping,
    SwashCache, TextArea, TextAtlas, TextBounds, TextRenderer, Viewport, Weight,
};

use winit::application::ApplicationHandler;
use winit::event::WindowEvent;
use winit::event_loop::{ActiveEventLoop, ControlFlow, EventLoop, EventLoopProxy};
use winit::keyboard::{Key, NamedKey};
use winit::window::{Window, WindowId};

// ---------------------------------------------------------------------------
// Theme. The Marlin Dark palette from the design mock, so the spike looks like
// the thing rather than like a demo.
// ---------------------------------------------------------------------------

const BG: [f64; 3] = [0.039, 0.059, 0.086]; // #0A0F16
const FG: GColor = GColor::rgb(0xC6, 0xD3, 0xE1);
const DIM: GColor = GColor::rgb(0x5C, 0x6E, 0x82);
const ACCENT: GColor = GColor::rgb(0x4C, 0x8D, 0xFF);
const GREEN: GColor = GColor::rgb(0x5F, 0xD3, 0xA0);
const YELLOW: GColor = GColor::rgb(0xE8, 0xB4, 0x4C);
const RED: GColor = GColor::rgb(0xFF, 0x7A, 0x7A);
const CYAN: GColor = GColor::rgb(0x4F, 0xD1, 0xE0);
const MAGENTA: GColor = GColor::rgb(0xD4, 0x8B, 0xFF);

const FONT_SIZE: f32 = 13.0;
const LINE_HEIGHT: f32 = 20.0;
const PADDING: f32 = 10.0;

fn ansi_to_glyphon(c: AnsiColor) -> GColor {
    match c {
        AnsiColor::Named(n) => match n {
            NamedColor::Black | NamedColor::BrightBlack => DIM,
            NamedColor::Red | NamedColor::BrightRed => RED,
            NamedColor::Green | NamedColor::BrightGreen => GREEN,
            NamedColor::Yellow | NamedColor::BrightYellow => YELLOW,
            NamedColor::Blue | NamedColor::BrightBlue => ACCENT,
            NamedColor::Magenta | NamedColor::BrightMagenta => MAGENTA,
            NamedColor::Cyan | NamedColor::BrightCyan => CYAN,
            _ => FG,
        },
        AnsiColor::Spec(rgb) => GColor::rgb(rgb.r, rgb.g, rgb.b),
        AnsiColor::Indexed(i) => match i {
            1 | 9 => RED,
            2 | 10 => GREEN,
            3 | 11 => YELLOW,
            4 | 12 => ACCENT,
            5 | 13 => MAGENTA,
            6 | 14 => CYAN,
            _ => FG,
        },
    }
}

// ---------------------------------------------------------------------------
// The bridge from alacritty_terminal's io thread back into winit.
//
// This is the damage signal. The pty thread tells us something changed; we ask
// winit for one redraw. Nothing else drives drawing, so an idle terminal draws
// zero frames.
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
enum UserEvent {
    Wakeup,
    Exit,
}

#[derive(Clone)]
struct EventProxy(EventLoopProxy<UserEvent>);

impl EventListener for EventProxy {
    fn send_event(&self, event: TermEvent) {
        match event {
            TermEvent::Wakeup | TermEvent::Bell | TermEvent::Title(_) => {
                let _ = self.0.send_event(UserEvent::Wakeup);
            }
            TermEvent::Exit => {
                let _ = self.0.send_event(UserEvent::Exit);
            }
            _ => {}
        }
    }
}

/// alacritty_terminal wants something that reports the grid size. For the spike
/// the size is fixed at startup; resizing is Phase 1 work.
#[derive(Clone, Copy)]
struct GridSize {
    columns: usize,
    screen_lines: usize,
}

impl Dimensions for GridSize {
    fn total_lines(&self) -> usize {
        self.screen_lines
    }
    fn screen_lines(&self) -> usize {
        self.screen_lines
    }
    fn columns(&self) -> usize {
        self.columns
    }
}

// ---------------------------------------------------------------------------
// GPU
// ---------------------------------------------------------------------------

struct Gpu {
    surface: wgpu::Surface<'static>,
    device: wgpu::Device,
    queue: wgpu::Queue,
    config: wgpu::SurfaceConfiguration,
    font_system: FontSystem,
    swash: SwashCache,
    viewport: Viewport,
    atlas: TextAtlas,
    renderer: TextRenderer,
    buffer: Buffer,
}

impl Gpu {
    fn new(window: Arc<Window>) -> anyhow::Result<Self> {
        let size = window.inner_size();
        let instance =
            wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle_from_env());
        let surface = instance.create_surface(window.clone())?;

        // `..Default::default()` on purpose rather than naming every field:
        // these descriptors gain fields most wgpu releases, and a spike that
        // breaks on every bump teaches nothing.
        let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
            power_preference: wgpu::PowerPreference::LowPower,
            compatible_surface: Some(&surface),
            force_fallback_adapter: false,
            ..Default::default()
        }))?;

        let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
            label: Some("marlin"),
            required_features: wgpu::Features::empty(),
            required_limits: wgpu::Limits::downlevel_defaults(),
            ..Default::default()
        }))?;

        // Derive the config from the surface rather than hand-building it, then
        // override only the two fields this project actually has an opinion
        // about. Hand-building it broke on the first compile.
        let mut config = surface
            .get_default_config(&adapter, size.width.max(1), size.height.max(1))
            .ok_or_else(|| anyhow::anyhow!("surface is not supported by this adapter"))?;

        let caps = surface.get_capabilities(&adapter);
        if let Some(srgb) = caps.formats.iter().copied().find(|f| f.is_srgb()) {
            config.format = srgb;
        }
        let format = config.format;

        // The vsync queue is worth a frame of latency, and latency is the point.
        config.present_mode = wgpu::PresentMode::AutoNoVsync;
        config.desired_maximum_frame_latency = 1;

        surface.configure(&device, &config);

        let mut font_system = FontSystem::new();
        let swash = SwashCache::new();
        let cache = Cache::new(&device);
        let viewport = Viewport::new(&device, &cache);
        let mut atlas = TextAtlas::new(&device, &queue, &cache, format);
        let renderer =
            TextRenderer::new(&mut atlas, &device, wgpu::MultisampleState::default(), None);

        let mut buffer = Buffer::new(&mut font_system, Metrics::new(FONT_SIZE, LINE_HEIGHT));
        buffer.set_size(
            Some(size.width as f32 - PADDING * 2.0),
            Some(size.height as f32 - PADDING * 2.0),
        );

        Ok(Self {
            surface,
            device,
            queue,
            config,
            font_system,
            swash,
            viewport,
            atlas,
            renderer,
            buffer,
        })
    }

    fn resize(&mut self, w: u32, h: u32) {
        self.config.width = w.max(1);
        self.config.height = h.max(1);
        self.surface.configure(&self.device, &self.config);
        self.buffer.set_size(
            Some(w as f32 - PADDING * 2.0),
            Some(h as f32 - PADDING * 2.0),
        );
    }

    /// Draw one frame from a snapshot of the grid. Called only when something
    /// changed.
    fn render(&mut self, spans: &[(String, GColor)]) -> anyhow::Result<()> {
        let default_attrs = Attrs::new().family(Family::Monospace).weight(Weight::NORMAL);

        let rich: Vec<(&str, Attrs)> = spans
            .iter()
            .map(|(text, color)| (text.as_str(), default_attrs.clone().color(*color)))
            .collect();

        self.buffer
            .set_rich_text(rich, &default_attrs, Shaping::Advanced, None);
        self.buffer.shape_until_scroll(&mut self.font_system, false);

        self.viewport.update(
            &self.queue,
            Resolution {
                width: self.config.width,
                height: self.config.height,
            },
        );

        self.renderer.prepare(
            &self.device,
            &self.queue,
            &mut self.font_system,
            &mut self.atlas,
            &self.viewport,
            [TextArea {
                buffer: &self.buffer,
                left: PADDING,
                top: PADDING,
                scale: 1.0,
                bounds: TextBounds {
                    left: 0,
                    top: 0,
                    right: self.config.width as i32,
                    bottom: self.config.height as i32,
                },
                default_color: FG,
                custom_glyphs: &[],
            }],
            &mut self.swash,
        )?;

        // wgpu 30 returns an enum rather than a Result, and one variant is
        // `Occluded`. That is the "stop drawing when the window is hidden" rule
        // from the design handed to us by the platform: skip the frame entirely.
        let frame = match self.surface.get_current_texture() {
            wgpu::CurrentSurfaceTexture::Success(f) => f,
            wgpu::CurrentSurfaceTexture::Suboptimal(f) => f,
            wgpu::CurrentSurfaceTexture::Occluded | wgpu::CurrentSurfaceTexture::Timeout => {
                return Ok(())
            }
            wgpu::CurrentSurfaceTexture::Outdated | wgpu::CurrentSurfaceTexture::Lost => {
                self.surface.configure(&self.device, &self.config);
                return Ok(());
            }
            other => anyhow::bail!("surface unavailable: {other:?}"),
        };
        let view = frame.texture.create_view(&Default::default());
        let mut encoder = self
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor { label: None });
        {
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("marlin.text"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &view,
                    resolve_target: None,
                    depth_slice: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(wgpu::Color {
                            r: BG[0],
                            g: BG[1],
                            b: BG[2],
                            a: 1.0,
                        }),
                        store: wgpu::StoreOp::Store,
                    },
                })],
                ..Default::default()
            });
            self.renderer.render(&self.atlas, &self.viewport, &mut pass)?;
        }
        self.queue.submit(Some(encoder.finish()));
        // wgpu 30 moved present onto the queue.
        self.queue.present(frame);
        self.atlas.trim();
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// The app
// ---------------------------------------------------------------------------

struct Marlin {
    proxy: EventLoopProxy<UserEvent>,
    window: Option<Arc<Window>>,
    gpu: Option<Gpu>,
    term: Option<Arc<FairMutex<Term<EventProxy>>>>,
    notifier: Option<Notifier>,
    grid: GridSize,
    /// Frames actually drawn. The number that proves damage-driven rendering,
    /// and the one the performance HUD will show later.
    redraws: Arc<Mutex<u64>>,
}

impl Marlin {
    fn new(proxy: EventLoopProxy<UserEvent>) -> Self {
        Self {
            proxy,
            window: None,
            gpu: None,
            term: None,
            notifier: None,
            grid: GridSize {
                columns: 100,
                screen_lines: 30,
            },
            redraws: Arc::new(Mutex::new(0)),
        }
    }

    fn start_pty(&mut self) -> anyhow::Result<()> {
        let event_proxy = EventProxy(self.proxy.clone());

        let window_size = WindowSize {
            num_lines: self.grid.screen_lines as u16,
            num_cols: self.grid.columns as u16,
            cell_width: 8,
            cell_height: LINE_HEIGHT as u16,
        };

        let pty = tty::new(&tty::Options::default(), window_size, 0)?;

        let term = Term::new(TermConfig::default(), &self.grid, event_proxy.clone());
        let term = Arc::new(FairMutex::new(term));

        let pty_loop = PtyEventLoop::new(term.clone(), event_proxy, pty, false, false)?;
        self.notifier = Some(Notifier(pty_loop.channel()));
        let _io = pty_loop.spawn();

        self.term = Some(term);
        Ok(())
    }

    /// Snapshot the grid into coloured runs. Cheap and allocation-heavy, which
    /// is fine for a spike: Phase 1 replaces this with cached shaped rows.
    fn snapshot(&self) -> Vec<(String, GColor)> {
        let Some(term) = &self.term else {
            return vec![];
        };
        let term = term.lock();
        let grid = term.grid();

        let mut spans: Vec<(String, GColor)> = Vec::new();
        let mut current = String::new();
        let mut current_color = FG;

        for line in 0..self.grid.screen_lines {
            for col in 0..self.grid.columns {
                let cell = &grid[Line(line as i32)][Column(col)];
                let color = ansi_to_glyphon(cell.fg);
                if color != current_color && !current.is_empty() {
                    spans.push((std::mem::take(&mut current), current_color));
                }
                current_color = color;
                current.push(cell.c);
            }
            current.push('\n');
        }
        if !current.is_empty() {
            spans.push((current, current_color));
        }
        spans
    }

    fn draw(&mut self) {
        let spans = self.snapshot();
        if let Some(gpu) = &mut self.gpu {
            if let Err(e) = gpu.render(&spans) {
                eprintln!("marlin: render failed: {e}");
            } else {
                let mut n = self.redraws.lock().unwrap();
                *n += 1;
            }
        }
    }

    fn send(&self, bytes: Vec<u8>) {
        if let Some(n) = &self.notifier {
            n.notify(bytes);
        }
    }
}

impl ApplicationHandler<UserEvent> for Marlin {
    fn resumed(&mut self, event_loop: &ActiveEventLoop) {
        if self.window.is_some() {
            return;
        }
        let attrs = Window::default_attributes()
            .with_title("marlin")
            .with_inner_size(winit::dpi::LogicalSize::new(900.0, 640.0));
        let window = Arc::new(event_loop.create_window(attrs).expect("window"));

        match Gpu::new(window.clone()) {
            Ok(gpu) => self.gpu = Some(gpu),
            Err(e) => {
                eprintln!("marlin: gpu init failed: {e}");
                event_loop.exit();
                return;
            }
        }
        if let Err(e) = self.start_pty() {
            eprintln!("marlin: pty failed: {e}");
            event_loop.exit();
            return;
        }
        self.window = Some(window);
        self.draw();
    }

    fn user_event(&mut self, event_loop: &ActiveEventLoop, event: UserEvent) {
        match event {
            // The pty produced output. This is the only thing that schedules a
            // frame, which is what "idle CPU 0.0%" actually means in code.
            UserEvent::Wakeup => {
                if let Some(w) = &self.window {
                    w.request_redraw();
                }
            }
            UserEvent::Exit => {
                println!(
                    "marlin: shell exited after {} redraws",
                    self.redraws.lock().unwrap()
                );
                event_loop.exit();
            }
        }
    }

    fn window_event(&mut self, event_loop: &ActiveEventLoop, _id: WindowId, event: WindowEvent) {
        match event {
            WindowEvent::CloseRequested => {
                if let Some(n) = &self.notifier {
                    let _ = n.0.send(Msg::Shutdown);
                }
                println!(
                    "marlin: {} redraws this session",
                    self.redraws.lock().unwrap()
                );
                event_loop.exit();
            }
            WindowEvent::Resized(size) => {
                if let Some(gpu) = &mut self.gpu {
                    gpu.resize(size.width, size.height);
                }
                if let Some(w) = &self.window {
                    w.request_redraw();
                }
            }
            WindowEvent::RedrawRequested => self.draw(),
            WindowEvent::KeyboardInput { event, .. } => {
                if !event.state.is_pressed() {
                    return;
                }
                // Straight to the pty in the event handler. Never queued for the
                // next frame: that is the single most common way a terminal
                // feels slow while benchmarking well.
                let bytes: Option<Vec<u8>> = match event.logical_key {
                    Key::Named(NamedKey::Enter) => Some(b"\r".to_vec()),
                    Key::Named(NamedKey::Backspace) => Some(vec![0x7f]),
                    Key::Named(NamedKey::Tab) => Some(b"\t".to_vec()),
                    Key::Named(NamedKey::Escape) => Some(vec![0x1b]),
                    Key::Named(NamedKey::ArrowUp) => Some(b"\x1b[A".to_vec()),
                    Key::Named(NamedKey::ArrowDown) => Some(b"\x1b[B".to_vec()),
                    Key::Named(NamedKey::ArrowRight) => Some(b"\x1b[C".to_vec()),
                    Key::Named(NamedKey::ArrowLeft) => Some(b"\x1b[D".to_vec()),
                    Key::Named(NamedKey::Space) => Some(b" ".to_vec()),
                    Key::Character(ref s) => Some(s.as_bytes().to_vec()),
                    _ => None,
                };
                if let Some(b) = bytes {
                    self.send(b);
                }
            }
            _ => {}
        }
    }
}

fn main() -> anyhow::Result<()> {
    let event_loop = EventLoop::<UserEvent>::with_user_event().build()?;
    // Wait for events. Not Poll: a terminal that spins the event loop when
    // nothing is happening cannot claim 0.0% idle.
    event_loop.set_control_flow(ControlFlow::Wait);
    let proxy = event_loop.create_proxy();
    let mut app = Marlin::new(proxy);
    event_loop.run_app(&mut app)?;
    Ok(())
}
