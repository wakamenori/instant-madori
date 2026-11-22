use crate::{
    DisplaySummary, ViewerErrorCode as Code, ViewerFailure as Failure, camera, decoded,
    scene::{self, ShownScene},
    summary,
};
use solidcraft_viewport::{Camera, MAX_SECTION_PLANES};
use solidcraft_viewport_gpu::view::{Frame, GpuTarget, Renderer, far_depth, reversed_depth};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
};
use wasm_bindgen::prelude::*;
use web_sys::HtmlCanvasElement;
#[wasm_bindgen]
pub struct Viewer {
    instance: wgpu::Instance,
    canvas: HtmlCanvasElement,
    surface: wgpu::Surface<'static>,
    device: wgpu::Device,
    queue: wgpu::Queue,
    config: wgpu::SurfaceConfiguration,
    depth: wgpu::TextureView,
    depth_format: wgpu::TextureFormat,
    renderer: Renderer,
    lost: Arc<AtomicBool>,
    loss: js_sys::Promise,
    scene: Option<ShownScene>,
    size: camera::ViewSize,
    camera: Camera,
    fitted: bool,
    key: u64,
    dirty: bool,
}
#[wasm_bindgen]
impl Viewer {
    pub async fn create(canvas: HtmlCanvasElement) -> Result<Viewer, Failure> {
        if !wgpu::util::is_browser_webgpu_supported().await {
            return Err(Failure::new(
                Code::WebGpuUnavailable,
                "WebGPU is unavailable",
            ));
        }
        let instance = wgpu::Instance::new(wgpu::InstanceDescriptor {
            backends: wgpu::Backends::BROWSER_WEBGPU,
            ..wgpu::InstanceDescriptor::new_without_display_handle()
        });
        let surface = instance
            .create_surface(wgpu::SurfaceTarget::Canvas(canvas.clone()))
            .map_err(|e| Failure::new(Code::SurfaceUnavailable, e))?;
        let adapter = instance
            .request_adapter(&wgpu::RequestAdapterOptions {
                compatible_surface: Some(&surface),
                ..Default::default()
            })
            .await
            .map_err(|e| Failure::new(Code::AdapterUnavailable, e))?;
        let (device, queue) = adapter
            .request_device(&wgpu::DeviceDescriptor {
                label: Some("madori viewer"),
                required_limits: wgpu::Limits::downlevel_defaults()
                    .using_resolution(adapter.limits()),
                ..Default::default()
            })
            .await
            .map_err(|e| Failure::new(Code::DeviceUnavailable, e))?;
        let lost = Arc::new(AtomicBool::new(false));
        let loss = js_sys::Promise::new(&mut |_resolve, reject| {
            let mark = lost.clone();
            device.set_device_lost_callback(move |_, detail| {
                mark.store(true, Ordering::Relaxed);
                let failure: JsValue = Failure::new(Code::DeviceLost, detail).into();
                let _ = reject.call1(&JsValue::NULL, &failure);
            });
        });
        let config = surface
            .get_default_config(&adapter, 1, 1)
            .ok_or_else(|| Failure::new(Code::SurfaceUnavailable, "No surface configuration"))?;
        surface.configure(&device, &config);
        let depth_format = solidcraft_viewport_gpu::depth_format(&device, false);
        let depth = depth_texture(&device, &config, depth_format);
        let renderer = Renderer::new(
            &device,
            GpuTarget {
                format: config.format,
                depth: Some(depth_format),
                samples: 1,
                tess: false,
                oit: false,
                edges: false,
            },
            None,
        );
        Ok(Self {
            instance,
            canvas,
            surface,
            device,
            queue,
            config,
            depth,
            depth_format,
            renderer,
            lost,
            loss,
            scene: None,
            size: camera::ViewSize::default(),
            camera: Camera::default(),
            fitted: false,
            key: 0,
            dirty: true,
        })
    }
    pub fn device_lost(&self) -> js_sys::Promise {
        self.loss.clone()
    }
    pub fn show(&mut self, bytes: &[u8]) -> Result<DisplaySummary, Failure> {
        let model = decoded(bytes)?;
        self.key = self.key.wrapping_add(1);
        let scene = scene::build(&model, self.key);
        let aspect = self.aspect();
        camera::fit_first(&mut self.camera, &mut self.fitted, &scene.bounds, aspect);
        self.scene = Some(scene);
        self.dirty = true;
        Ok(summary(&model))
    }
    pub fn resize(&mut self, width: f64, height: f64, scale: f64) {
        let Some(size) = camera::ViewSize::new(width, height, scale) else {
            return;
        };
        self.size = size;
        let [width, height] = size.device(self.device.limits().max_texture_dimension_2d);
        if [width, height] == [self.config.width, self.config.height] {
            return;
        }
        self.config.width = width;
        self.config.height = height;
        self.reconfigure();
        self.dirty = true;
    }
    pub fn pan(&mut self, dx: f32, dy: f32) {
        camera::pan(&mut self.camera, dx, dy, &self.size);
        self.dirty = true;
    }
    pub fn reset_view(&mut self) {
        let Some(scene) = &self.scene else {
            return;
        };
        let aspect = self.aspect();
        if camera::reset(&mut self.camera, &scene.bounds, aspect) {
            self.dirty = true;
        }
    }
    pub fn orbit(&mut self, dx: f32, dy: f32) {
        camera::orbit(&mut self.camera, dx, dy);
        self.dirty = true;
    }
    pub fn zoom(&mut self, delta: f32, _x: f32, _y: f32) {
        camera::zoom(&mut self.camera, delta);
        self.dirty = true;
    }
    /// False requests another frame after surface recovery; true means the frame is complete.
    pub fn draw(&mut self) -> Result<bool, Failure> {
        if self.lost.load(Ordering::Relaxed) {
            return Err(Failure::new(Code::DeviceLost, "WebGPU device lost"));
        }
        if !self.dirty {
            return Ok(true);
        }
        let Some(scene) = &self.scene else {
            return Ok(true);
        };
        let output = match self.surface.get_current_texture() {
            wgpu::CurrentSurfaceTexture::Success(output) => output,
            wgpu::CurrentSurfaceTexture::Suboptimal(output) => {
                drop(output);
                self.reconfigure();
                return Ok(false);
            }
            wgpu::CurrentSurfaceTexture::Outdated => {
                self.reconfigure();
                return Ok(false);
            }
            wgpu::CurrentSurfaceTexture::Lost => {
                self.surface = self
                    .instance
                    .create_surface(wgpu::SurfaceTarget::Canvas(self.canvas.clone()))
                    .map_err(|e| Failure::new(Code::SurfaceUnavailable, e))?;
                self.reconfigure();
                return Ok(false);
            }
            wgpu::CurrentSurfaceTexture::Timeout | wgpu::CurrentSurfaceTexture::Occluded => {
                return Ok(false);
            }
            wgpu::CurrentSurfaceTexture::Validation => {
                return Err(Failure::new(
                    Code::SurfaceUnavailable,
                    "Surface validation failed",
                ));
            }
        };
        let frame = frame(
            &self.camera,
            self.aspect(),
            [self.config.width, self.config.height],
            scene,
        );
        let view = output.texture.create_view(&Default::default());
        let mut encoder = self.device.create_command_encoder(&Default::default());
        self.renderer
            .prepare(&self.device, &self.queue, &mut encoder, &frame);
        {
            let mut pass = encoder
                .begin_render_pass(&wgpu::RenderPassDescriptor {
                    label: Some("madori display"),
                    color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                        view: &view,
                        depth_slice: None,
                        resolve_target: None,
                        ops: wgpu::Operations {
                            load: wgpu::LoadOp::Clear(wgpu::Color {
                                r: 0.94,
                                g: 0.95,
                                b: 0.96,
                                a: 1.,
                            }),
                            store: wgpu::StoreOp::Store,
                        },
                    })],
                    depth_stencil_attachment: Some(wgpu::RenderPassDepthStencilAttachment {
                        view: &self.depth,
                        depth_ops: Some(wgpu::Operations {
                            load: wgpu::LoadOp::Clear(far_depth(reversed_depth(Some(
                                self.depth_format,
                            )))),
                            store: wgpu::StoreOp::Discard,
                        }),
                        stencil_ops: None,
                    }),
                    timestamp_writes: None,
                    occlusion_query_set: None,
                    multiview_mask: None,
                })
                .forget_lifetime();
            self.renderer.paint(
                &frame,
                &mut pass,
                [0., 0., self.config.width as f32, self.config.height as f32],
            );
        }
        self.queue.submit([encoder.finish()]);
        self.queue.present(output);
        self.dirty = false;
        Ok(true)
    }
}
impl Viewer {
    fn aspect(&self) -> f64 {
        f64::from(self.config.width) / f64::from(self.config.height)
    }
    fn reconfigure(&mut self) {
        self.surface.configure(&self.device, &self.config);
        self.depth = depth_texture(&self.device, &self.config, self.depth_format);
    }
}
fn depth_texture(
    device: &wgpu::Device,
    config: &wgpu::SurfaceConfiguration,
    format: wgpu::TextureFormat,
) -> wgpu::TextureView {
    device
        .create_texture(&wgpu::TextureDescriptor {
            label: Some("madori depth"),
            size: wgpu::Extent3d {
                width: config.width,
                height: config.height,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
            view_formats: &[],
        })
        .create_view(&Default::default())
}
fn frame(camera: &Camera, aspect: f64, [width, height]: [u32; 2], scene: &ShownScene) -> Frame {
    let empty = || Arc::new(Mutex::new(None));
    let eye = camera.eye().to_f32();
    Frame {
        product_lights: None,
        product: false,
        upload_error: None,
        key: scene.key,
        slot: scene.slot.clone(),
        sketch_key: 0,
        sketch_slot: empty(),
        hl_key: 0,
        hl_slot: empty(),
        pv_key: 0,
        pv_slot: empty(),
        pv_hide: false,
        preview_bounds: None,
        view_proj: camera::view_proj(camera, aspect, &scene.bounds).to_f32(),
        turned_depth: None,
        back: camera.back().to_f32(),
        size_px: [width as f32, height as f32],
        clip: [[0.; 4]; MAX_SECTION_PLANES],
        clip_hatch: [0; MAX_SECTION_PLANES],
        cap: [0.; 4],
        images: Vec::new(),
        clouds: Vec::new(),
        analysis: [0.; 8],
        analysis_colors: [0.; 36],
        access: None,
        outline: true,
        eye: [eye[0], eye[1], eye[2], 1.],
        ao_radius: 0.,
        ao_samples: solidcraft_viewport_gpu::view::AO_SAMPLES,
        sky: [0.; 4],
        ssaa: 1.,
        hover_tint: [0.; 3],
        selection_tint: [0.; 3],
        hatch: Default::default(),
        moving: None,
    }
}
