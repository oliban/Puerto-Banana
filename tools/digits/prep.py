import numpy as np, gzip, pickle
from scipy import ndimage as nd

def norm(img):
    """MNIST-style: crop to ink, scale longest side to 20px, center by mass in 28x28."""
    m = img > 0.1
    if not m.any(): return np.zeros((28,28), np.float32)
    ys, xs = np.where(m)
    c = img[ys.min():ys.max()+1, xs.min():xs.max()+1]
    h, w = c.shape
    s = 20.0 / max(h, w)
    nh, nw = max(1, round(h*s)), max(1, round(w*s))
    c = nd.zoom(c, (nh/h, nw/w), order=1)
    c = np.clip(c, 0, 1)
    out = np.zeros((28,28), np.float32)
    y0, x0 = (28-nh)//2, (28-nw)//2
    out[y0:y0+nh, x0:x0+nw] = c[:nh,:nw]
    cy, cx = nd.center_of_mass(out)
    out = nd.shift(out, (14-cy, 14-cx), order=1, mode='constant')
    return np.clip(out, 0, 1).astype(np.float32)

def augment(img, rng):
    a = np.deg2rad(rng.uniform(-14, 14)); sh = rng.uniform(-0.3, 0.3)
    sx, sy = rng.uniform(0.75, 1.25), rng.uniform(0.85, 1.15)
    M = np.array([[np.cos(a), -np.sin(a)], [np.sin(a), np.cos(a)]]) @ np.array([[1, sh], [0, 1]]) @ np.diag([sy, sx])
    Mi = np.linalg.inv(M); c = np.array([14, 14])
    big = np.zeros((40,40), np.float32); big[6:34,6:34] = img
    c = np.array([20,20])
    o = c - Mi @ c
    t = nd.affine_transform(big, Mi, offset=o, order=1)
    r = rng.random()
    if r < 0.3: t = nd.grey_dilation(t, size=(2,2))
    elif r < 0.45: t = nd.grey_erosion(t, size=(2,2)) if t.max() > 0.5 else t
    return norm(t)

def load():
    with gzip.open('/tmp/mnist.pkl.gz') as f:
        tr, va, te = pickle.load(f, encoding='latin1')
    return tr, va, te
