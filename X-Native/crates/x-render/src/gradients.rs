//! Phase 6: Advanced gradient rendering utilities
//!
//! This module provides rendering support for Angular and Diamond gradients,
//! including conversion to mesh approximations and shader parameters.

use vello::kurbo::{Point, Rect};
use x_core::Paint;

/// Phase 6: Render parameters for Angular gradient
#[derive(Debug, Clone)]
pub struct AngularGradientParams {
    pub center: Point,
    pub start_angle: f32,  // radians
    pub end_angle: f32,    // radians
    pub stops: Vec<(f32, [f32; 4])>,  // (position, RGBA)
}

/// Phase 6: Render parameters for Diamond gradient
#[derive(Debug, Clone)]
pub struct DiamondGradientParams {
    pub center: Point,
    pub width: f32,
    pub height: f32,
    pub stops: Vec<(f32, [f32; 4])>,  // (position, RGBA)
}

/// Phase 6: Convert Paint to AngularGradientParams for rendering
pub fn angular_gradient_params(paint: &Paint, bounds: Rect) -> Option<AngularGradientParams> {
    match paint {
        Paint::AngularGradient {
            center,
            start_angle,
            end_angle,
            stops,
            space,
        } => {
            // Convert center from relative (0-1) to absolute coordinates
            let abs_center = Point::new(
                bounds.x0 + center.0 * bounds.width(),
                bounds.y0 + center.1 * bounds.height(),
            );
            
            // Convert color stops to RGBA
            let render_stops: Vec<(f32, [f32; 4])> = stops.iter().map(|(pos, color)| {
                let rgba = color.to_rgba8();
                (*pos, [
                    rgba.r as f32 / 255.0,
                    rgba.g as f32 / 255.0,
                    rgba.b as f32 / 255.0,
                    rgba.a as f32 / 255.0,
                ])
            }).collect();
            
            Some(AngularGradientParams {
                center: abs_center,
                start_angle: (*start_angle as f32).to_radians(),
                end_angle: (*end_angle as f32).to_radians(),
                stops: render_stops,
            })
        }
        _ => None,
    }
}

/// Phase 6: Convert Paint to DiamondGradientParams for rendering
pub fn diamond_gradient_params(paint: &Paint, bounds: Rect) -> Option<DiamondGradientParams> {
    match paint {
        Paint::DiamondGradient {
            center,
            width,
            height,
            stops,
            space,
        } => {
            // Convert center from relative (0-1) to absolute coordinates
            let abs_center = Point::new(
                bounds.x0 + center.0 * bounds.width(),
                bounds.y0 + center.1 * bounds.height(),
            );
            
            // Convert width/height from relative to absolute
            let abs_width = width * bounds.width();
            let abs_height = height * bounds.height();
            
            // Convert color stops to RGBA
            let render_stops: Vec<(f32, [f32; 4])> = stops.iter().map(|(pos, color)| {
                let rgba = color.to_rgba8();
                (*pos, [
                    rgba.r as f32 / 255.0,
                    rgba.g as f32 / 255.0,
                    rgba.b as f32 / 255.0,
                    rgba.a as f32 / 255.0,
                ])
            }).collect();
            
            Some(DiamondGradientParams {
                center: abs_center,
                width: abs_width as f32,
                height: abs_height as f32,
                stops: render_stops,
            })
        }
        _ => None,
    }
}

/// Phase 6: Generate mesh approximation for Angular gradient
/// Returns vertices and indices for rendering
pub fn angular_gradient_mesh(
    params: &AngularGradientParams,
    bounds: Rect,
    segments: usize,
) -> (Vec<Vertex>, Vec<u32>) {
    let mut vertices = Vec::new();
    let mut indices = Vec::new();
    
    // Center vertex
    vertices.push(Vertex {
        position: [params.center.x as f32, params.center.y as f32],
        color: [1.0, 1.0, 1.0, 1.0], // White at center
    });
    
    // Generate vertices around the circle
    let angle_step = (params.end_angle - params.start_angle) / segments as f32;
    
    for i in 0..=segments {
        let angle = params.start_angle + i as f32 * angle_step;
        
        // Find color at this angle by interpolating stops
        let t = (i as f32 / segments as f32).fract();
        let color = interpolate_stops(&params.stops, t);
        
        // Calculate vertex position on the boundary
        let radius = bounds.width().max(bounds.height()) as f32;
        let x = params.center.x + radius * angle.cos();
        let y = params.center.y + radius * angle.sin();
        
        vertices.push(Vertex {
            position: [x as f32, y as f32],
            color,
        });
        
        // Create triangle from center to this vertex and next
        if i > 0 {
            indices.push(0); // Center
            indices.push(i as u32);
            indices.push((i + 1) as u32);
        }
    }
    
    (vertices, indices)
}

/// Phase 6: Generate mesh approximation for Diamond gradient
pub fn diamond_gradient_mesh(
    params: &DiamondGradientParams,
    bounds: Rect,
    subdivisions: usize,
) -> (Vec<Vertex>, Vec<u32>) {
    let mut vertices = Vec::new();
    let mut indices = Vec::new();
    
    // Generate a grid of vertices
    let step_x = bounds.width() as f32 / subdivisions as f32;
    let step_y = bounds.height() as f32 / subdivisions as f32;
    
    for j in 0..=subdivisions {
        for i in 0..=subdivisions {
            let x = bounds.x0 as f32 + i as f32 * step_x;
            let y = bounds.y0 as f32 + j as f32 * step_y;
            
            // Calculate distance from center in diamond metric
            let dx = (x - params.center.x as f32).abs() / params.width;
            let dy = (y - params.center.y as f32).abs() / params.height;
            let t = (dx + dy).clamp(0.0, 1.0);
            
            // Interpolate color based on diamond distance
            let color = interpolate_stops(&params.stops, t);
            
            vertices.push(Vertex {
                position: [x, y],
                color,
            });
            
            // Create triangles
            if i > 0 && j > 0 {
                let idx = (j * (subdivisions + 1) + i) as u32;
                let prev_row = ((j - 1) * (subdivisions + 1) + i) as u32;
                let prev_col = (j * (subdivisions + 1) + i - 1) as u32;
                let prev_diag = ((j - 1) * (subdivisions + 1) + i - 1) as u32;
                
                // Two triangles per quad
                indices.push(prev_diag);
                indices.push(prev_col);
                indices.push(idx);
                
                indices.push(prev_diag);
                indices.push(idx);
                indices.push(prev_row);
            }
        }
    }
    
    (vertices, indices)
}

/// Phase 6: Vertex structure for gradient meshes
#[derive(Debug, Clone, Copy)]
pub struct Vertex {
    pub position: [f32; 2],
    pub color: [f32; 4],
}

/// Phase 6: Interpolate color at position t along gradient stops
fn interpolate_stops(stops: &[(f32, [f32; 4])], t: f32) -> [f32; 4] {
    if stops.is_empty() {
        return [0.0, 0.0, 0.0, 1.0];
    }
    
    if stops.len() == 1 {
        return stops[0].1;
    }
    
    // Find the two stops to interpolate between
    for i in 0..stops.len() - 1 {
        let (t0, c0) = stops[i];
        let (t1, c1) = stops[i + 1];
        
        if t >= t0 && t <= t1 {
            // Linear interpolation between these two stops
            let local_t = if (t1 - t0) > 0.0 {
                (t - t0) / (t1 - t0)
            } else {
                0.0
            };
            
            return [
                c0[0] + (c1[0] - c0[0]) * local_t,
                c0[1] + (c1[1] - c0[1]) * local_t,
                c0[2] + (c1[2] - c0[2]) * local_t,
                c0[3] + (c1[3] - c0[3]) * local_t,
            ];
        }
    }
    
    // If t is outside all stops, return the nearest stop color
    if t <= stops[0].0 {
        stops[0].1
    } else {
        stops[stops.len() - 1].1
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use x_core::{Color, GradSpace};
    
    #[test]
    fn test_angular_gradient_creation() {
        let paint = Paint::angular_gradient(
            (0.5, 0.5),
            0.0,
            360.0,
            vec![
                (0.0, Color::from_rgb8(255, 0, 0)),
                (1.0, Color::from_rgb8(0, 0, 255)),
            ],
            GradSpace::Srgb,
        );
        
        let bounds = Rect::new(0.0, 0.0, 100.0, 100.0);
        let params = angular_gradient_params(&paint, bounds).unwrap();
        
        assert_eq!(params.center.x, 50.0);
        assert_eq!(params.center.y, 50.0);
        assert_eq!(params.stops.len(), 2);
    }
    
    #[test]
    fn test_diamond_gradient_creation() {
        let paint = Paint::diamond_gradient(
            (0.5, 0.5),
            0.5,
            0.5,
            vec![
                (0.0, Color::from_rgb8(255, 255, 0)),
                (1.0, Color::from_rgb8(0, 255, 255)),
            ],
            GradSpace::Srgb,
        );
        
        let bounds = Rect::new(0.0, 0.0, 200.0, 100.0);
        let params = diamond_gradient_params(&paint, bounds).unwrap();
        
        assert_eq!(params.center.x, 100.0);
        assert_eq!(params.center.y, 50.0);
        assert_eq!(params.width, 100.0);
        assert_eq!(params.height, 50.0);
    }
    
    #[test]
    fn test_color_interpolation() {
        let stops = vec![
            (0.0, [1.0, 0.0, 0.0, 1.0]),  // Red
            (1.0, [0.0, 0.0, 1.0, 1.0]),  // Blue
        ];
        
        // Middle should be purple-ish
        let mid = interpolate_stops(&stops, 0.5);
        assert!((mid[0] - 0.5).abs() < 0.01);  // R
        assert!((mid[2] - 0.5).abs() < 0.01);  // B
        
        // Start should be red
        let start = interpolate_stops(&stops, 0.0);
        assert!((start[0] - 1.0).abs() < 0.01);  // R
        assert!((start[2] - 0.0).abs() < 0.01);  // B
    }
}
