//! 与 Electron 相同的逻辑像素尺寸、主屏夹边和右下角展开锚点。
#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) struct Point { pub x: f64, pub y: f64 }
#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) struct Size { pub width: f64, pub height: f64 }
#[derive(Clone, Copy, Debug)]
pub(super) struct Area { pub origin: Point, pub size: Size }
pub(super) fn size(expanded: bool) -> Size {
    if expanded { Size { width: 400.0, height: 580.0 } } else { Size { width: 76.0, height: 76.0 } }
}
impl Area {
    pub fn clamp(self, point: Point, size: Size) -> Point {
        // 保留 Electron 的 Math.round 与 min(max, max(min, value)) 顺序，包括小工作区行为。
        let rounded = |v: f64| (v + 0.5).floor();
        Point {
            x: rounded(point.x).max(self.origin.x).min(self.origin.x + self.size.width - size.width),
            y: rounded(point.y).max(self.origin.y).min(self.origin.y + self.size.height - size.height),
        }
    }
    pub fn default_position(self, size: Size) -> Point {
        self.clamp(Point { x: self.origin.x + self.size.width - size.width - 24.0,
            y: self.origin.y + self.size.height - size.height - 24.0 }, size)
    }
    pub fn resize(self, position: Point, previous: Size, next: Size) -> Point {
        self.clamp(Point { x: position.x + previous.width - next.width, y: position.y + previous.height - next.height }, next)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn logical_sizes_default_margin_and_anchor_match_the_shared_ball() {
        let area = Area { origin: Point { x: 0.0, y: 40.0 }, size: Size { width: 1920.0, height: 1000.0 } };
        let small = size(false); let large = size(true);
        assert_eq!(area.default_position(small), Point { x: 1820.0, y: 940.0 });
        let expanded = area.resize(Point { x: 1820.0, y: 940.0 }, small, large);
        assert_eq!(expanded, Point { x: 1496.0, y: 436.0 });
        assert_eq!(area.resize(expanded, large, small), Point { x: 1820.0, y: 940.0 });
    }
    #[test]
    fn clamping_handles_work_area_offsets_and_small_displays() {
        let area = Area { origin: Point { x: 10.0, y: 30.0 }, size: Size { width: 300.0, height: 200.0 } };
        assert_eq!(area.clamp(Point { x: -200.0, y: 1000.0 }, size(false)), Point { x: 10.0, y: 154.0 });
        assert_eq!(area.default_position(size(true)), Point { x: -90.0, y: -350.0 });
    }
}
