The smallest building block—a single neuron—takes a vector of inputs x1,x2,...,xnx1​,x2​,...,xn​ and produces an output a=f(w1x1+w2x2+...+wnxn+b)a=f(w1​x1​+w2​x2​+...+wn​xn​+b), where the weights ww and bias bb are learnable parameters, and ff is an activation like ReLU (f(z)=max⁡(0,z)f(z)=max(0,z)) or sigmoid. Without a non‑linear activation, stacking layers would collapse into a single linear transformation, so the activation is what gives the network the power to model non‑linear relationships.

Initial parameters:
Parameter 	Value
w11,w12,b1w11​,w12​,b1​ (hidden neuron 1) 	0.4, 0.3, 0.2
w21,w22,b2w21​,w22​,b2​ (hidden neuron 2) 	−0.1, 0.6, −0.3
v1,v2,b3v1​,v2​,b3​ (output neuron) 	0.5, −0.2, 0.1
1. Forward pass

Hidden neuron 1:
z1=0.4(0.5)+0.3(0.1)+0.2=0.2+0.03+0.2=0.43
z1​=0.4(0.5)+0.3(0.1)+0.2=0.2+0.03+0.2=0.43
a1=σ(0.43)=11+e−0.43≈0.6059
a1​=σ(0.43)=1+e−0.431​≈0.6059

Hidden neuron 2:
z2=−0.1(0.5)+0.6(0.1)−0.3=−0.05+0.06−0.3=−0.29
z2​=−0.1(0.5)+0.6(0.1)−0.3=−0.05+0.06−0.3=−0.29
a2=σ(−0.29)=11+e0.29≈0.4280
a2​=σ(−0.29)=1+e0.291​≈0.4280

Output neuron:
z3=0.5(0.6059)+(−0.2)(0.4280)+0.1=0.3030−0.0856+0.1=0.3174
z3​=0.5(0.6059)+(−0.2)(0.4280)+0.1=0.3030−0.0856+0.1=0.3174
y^=σ(0.3174)=11+e−0.3174≈0.5787
y^​=σ(0.3174)=1+e−0.31741​≈0.5787

Loss:
L=12(y^−y)2=12(0.5787−1)2=12(0.4213)2≈0.0888
L=21​(y^​−y)2=21​(0.5787−1)2=21​(0.4213)2≈0.0888
2. Backward pass
Output layer
∂L∂y^=y^−y=−0.4213
∂y^​∂L​=y^​−y=−0.4213
∂y^∂z3=y^(1−y^)=0.5787×0.4213≈0.2438
∂z3​∂y^​​=y^​(1−y^​)=0.5787×0.4213≈0.2438
∂L∂z3=−0.4213×0.2438≈−0.1027(chain rule)
∂z3​∂L​=−0.4213×0.2438≈−0.1027(chain rule)

Gradients w.r.t. output parameters:
∂L∂v1=−0.1027×0.6059≈−0.0622
∂v1​∂L​=−0.1027×0.6059≈−0.0622
∂L∂v2=−0.1027×0.4280≈−0.0440
∂v2​∂L​=−0.1027×0.4280≈−0.0440
∂L∂b3=−0.1027
∂b3​∂L​=−0.1027
Hidden layer

Push the gradient back through the output weights:
∂L∂a1=∂L∂z3⋅v1=−0.1027×0.5=−0.0514
∂a1​∂L​=∂z3​∂L​⋅v1​=−0.1027×0.5=−0.0514
∂L∂a2=∂L∂z3⋅v2=−0.1027×(−0.2)=0.0205
∂a2​∂L​=∂z3​∂L​⋅v2​=−0.1027×(−0.2)=0.0205

Through the sigmoid derivative σ(z)(1−σ(z))σ(z)(1−σ(z)) for each hidden neuron:
∂a1∂z1=0.6059×0.3941≈0.2388⇒∂L∂z1=−0.0514×0.2388≈−0.0123
∂z1​∂a1​​=0.6059×0.3941≈0.2388⇒∂z1​∂L​=−0.0514×0.2388≈−0.0123
∂a2∂z2=0.4280×0.5720≈0.2448⇒∂L∂z2=0.0205×0.2448≈0.0050
∂z2​∂a2​​=0.4280×0.5720≈0.2448⇒∂z2​∂L​=0.0205×0.2448≈0.0050

Gradients w.r.t. hidden parameters:
∂L∂w11=−0.0123×0.5=−0.0061∂L∂w12=−0.0123×0.1=−0.0012∂L∂b1=−0.0123
∂w11​∂L​=−0.0123×0.5=−0.0061∂w12​∂L​=−0.0123×0.1=−0.0012∂b1​∂L​=−0.0123
∂L∂w21=0.0050×0.5=0.0025∂L∂w22=0.0050×0.1=0.0005∂L∂b2=0.0050
∂w21​∂L​=0.0050×0.5=0.0025∂w22​∂L​=0.0050×0.1=0.0005∂b2​∂L​=0.0050
3. Parameter update (learning rate η = 0.5)

Rule: θ←θ−η⋅∂L∂θθ←θ−η⋅∂θ∂L​
